// HTTP(REST / webhook)の API 表面と、サービス間 HTTP 呼び出しの検出(docs/SPEC.md §6.9)。
//
// gRPC と同じ考え方で「定義(ルート)」と「呼び出し(クライアント)」を別々に集め、
// パスの正規化キーで突き合わせてサービス境界を越えた辺を張る。
// 誤接続を避けるため、候補が 1 件に定まるときだけ接続する(RPC 解決と同じ方針)。
//
// 対応フレームワーク:
//   Go     gin / echo / chi / gorilla mux / net/http(Go 1.22 の "GET /path" 形式を含む)
//   TS/JS  Express / Fastify / Hono / Koa、Next.js App Router(app/**/route.ts)
//   Python FastAPI / Flask
//   Elixir Phoenix Router
// クライアント側:
//   Go     http.Get/Post/NewRequest(WithContext)、resty 等の .Get(url)
//   TS/JS  fetch / axios
//   Python requests / httpx
//
// 無効化: strata.config.json の { "http": { "enabled": false } }

import { readFileText, type Ctx, type Project } from '../context.ts';
import { makeLineFinder, matchBrace, stripSource } from '../lex.ts';
import {
  buildFuncIndex,
  enclosingNodeId,
  looksLikeWebhook,
  normalizePath,
  pathKey,
  topAncestorId,
  type FuncIndex,
} from './endpoints.ts';

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

/**
 * 外部システム(自リポジトリ外の HTTP 相手)をまとめる親ノード。
 * 受信(外部 → 自システム)と送信(自システム → 外部)を別ノードに分ける。
 * 1 つにまとめると「外部 ⇄ サービス」が循環依存として検出されてしまうため。
 */
const EXT_IN_ID = 'ext:http:in';
const EXT_OUT_ID = 'ext:http:out';

interface RouteRec {
  method: string;
  path: string; // 正規化前(表示用)
  file: string;
  line: number;
  handler?: string; // ハンドラ式(最後の識別子だけ使う)
  inline?: boolean; // その場に書かれた無名関数(名前で実装を引けない)
  framework: string;
  note?: string; // Phoenix のコントローラ等
}

interface CallRec {
  method?: string;
  raw: string; // 生の URL / パス
  file: string;
  line: number;
  host?: string; // 絶対 URL のときのホスト
}

/** 呼び出し引数の中身を返す(開き括弧の次から対応する閉じ括弧まで。文字列内の括弧は無視)。 */
function argsOf(src: string, openParen: number, limit = 600): string {
  let depth = 0;
  let quote = '';
  const end = Math.min(src.length, openParen + limit);
  for (let i = openParen; i < end; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      depth--;
      if (depth === 0) return src.slice(openParen + 1, i);
    }
  }
  return src.slice(openParen + 1, end);
}

/**
 * 引数テキストから URL らしい文字列リテラルを 1 つ取り出す。
 * "http://host/api/users/" + id のような連結は、末尾にパラメータが続くとみなして
 * ワイルドカードを補う(そうしないと /api/users とルート /api/users/{} が一致しない)。
 */
function urlLiteralOf(args: string): string | undefined {
  const re = /(["'`])((?:[^"'`\\]|\\.)*)\1/g;
  for (let m = re.exec(args); m; m = re.exec(args)) {
    const v = m[2];
    // 先頭がテンプレート変数のホスト(`${BASE}/api/x`)も対象にする
    if (!v.startsWith('/') && !/^[a-zA-Z][\w+.-]*:\/\//.test(v) && !/^\$?\{[^}]*\}\//.test(v)) continue;
    const after = args.slice(re.lastIndex, re.lastIndex + 8);
    const concatenated = /^\s*\+/.test(after);
    return concatenated && !v.endsWith('{}') ? (v.endsWith('/') ? v + '{}' : v + '/{}') : v;
  }
  return undefined;
}

/** 絶対 URL ならホストを返す。 */
function hostOf(raw: string): string | undefined {
  const m = /^[a-zA-Z][\w+.-]*:\/\/([^/\s"'`]+)/.exec(raw);
  if (!m) return undefined;
  const host = m[1].replace(/^[^@]*@/, '').replace(/\$\{[^}]*\}|%[sdv]/g, '');
  if (host === '' || /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/.test(host)) return undefined;
  return host;
}

/** args から method: 'POST' 相当を拾う(fetch / axios のオプション)。 */
function methodInOptions(args: string): string | undefined {
  const m = /\bmethod\s*:\s*(["'`])(\w+)\1/i.exec(args);
  return m ? m[2].toUpperCase() : undefined;
}

/** Go の http.MethodPost / "POST" いずれの書き方でもメソッド名を返す。 */
function goMethodLiteral(text: string): string | undefined {
  const c = /http\.Method([A-Za-z]+)/.exec(text);
  if (c) return c[1].toUpperCase();
  const s = /(["`])([A-Z]{3,7})\1/.exec(text);
  if (s && METHODS.includes(s[2])) return s[2];
  return undefined;
}

/** "GET /path" 形式(Go 1.22 の ServeMux)を method と path に割る。 */
function splitPattern(pattern: string): { method?: string; path: string } {
  const m = /^([A-Z]{3,7})\s+(\/.*)$/.exec(pattern.trim());
  if (m && METHODS.includes(m[1])) return { method: m[1], path: m[2] };
  return { path: pattern };
}

/** var → プレフィックスの連鎖を解決する(r := e.Group("/api") の入れ子)。 */
function resolvePrefixes(raw: Map<string, { parent: string; prefix: string }>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [name] of raw) {
    let prefix = '';
    let cur: string | undefined = name;
    for (let guard = 0; guard < 10 && cur; guard++) {
      const entry: { parent: string; prefix: string } | undefined = raw.get(cur);
      if (!entry) break;
      prefix = entry.prefix + prefix;
      cur = entry.parent;
    }
    out.set(name, prefix);
  }
  return out;
}

/* ---------------- Go ---------------- */

function scanGo(src: string, file: string, routes: RouteRec[], calls: CallRec[]): void {
  const { noComments, blanked } = stripSource(src, 'go');
  const lineOf = makeLineFinder(src);
  const hasGin = src.includes('gin-gonic');
  const hasEcho = src.includes('labstack/echo');
  const hasChi = src.includes('go-chi/chi');
  const hasMux = src.includes('gorilla/mux');
  const hasNetHttp = /"net\/http"/.test(noComments);
  const serverish = hasGin || hasEcho || hasChi || hasMux || hasNetHttp;
  const framework = hasGin ? 'gin' : hasEcho ? 'echo' : hasChi ? 'chi' : hasMux ? 'mux' : 'net/http';

  // グループ(プレフィックス)
  const groupRaw = new Map<string, { parent: string; prefix: string }>();
  const groupRe = /\b(\w+)\s*:?=\s*(\w+)\.(?:Group|PathPrefix)\(\s*"([^"]*)"/g;
  for (let m = groupRe.exec(noComments); m; m = groupRe.exec(noComments)) {
    groupRaw.set(m[1], { parent: m[2], prefix: m[3] });
  }
  const groupPrefix = resolvePrefixes(groupRaw);

  // chi の r.Route("/prefix", func(r chi.Router) { ... }) はブロック範囲でプレフィックスが効く
  const routeBlocks: Array<{ start: number; end: number; prefix: string }> = [];
  const routeBlockRe = /\.Route\(\s*"([^"]*)"\s*,\s*func\s*\([^)]*\)\s*\{/g;
  for (let m = routeBlockRe.exec(noComments); m; m = routeBlockRe.exec(noComments)) {
    const open = noComments.indexOf('{', m.index + m[0].length - 1);
    const close = matchBrace(blanked, open);
    if (open >= 0 && close > open) routeBlocks.push({ start: open, end: close, prefix: m[1] });
  }
  const blockPrefixAt = (index: number): string =>
    routeBlocks
      .filter((b) => index > b.start && index < b.end)
      .sort((a, b) => a.start - b.start)
      .map((b) => b.prefix)
      .join('');

  const addRoute = (method: string, rawPath: string, index: number, recv: string, handler?: string): void => {
    const prefix = (groupPrefix.get(recv) ?? '') + blockPrefixAt(index);
    routes.push({
      method,
      path: prefix + rawPath,
      file,
      line: lineOf(index),
      framework,
      ...(handler ? { handler } : {}),
    });
  };

  if (serverish) {
    // gin / echo / chi: r.GET("/path", handler) / r.Get("/path", handler)
    const methodRe = /\b(\w+)\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|Get|Post|Put|Patch|Delete|Head|Options)\(\s*"([^"]*)"\s*(,?)/g;
    for (let m = methodRe.exec(noComments); m; m = methodRe.exec(noComments)) {
      const path = m[3];
      if (!path.startsWith('/')) continue;
      if (m[4] !== ',') continue; // ハンドラ引数が無いものはクライアント呼び出し(resty 等)
      const rest = noComments.slice(methodRe.lastIndex, methodRe.lastIndex + 120);
      const handler = /^\s*([\w.]+)/.exec(rest)?.[1];
      addRoute(m[2].toUpperCase(), path, m.index, m[1], handler);
    }
    // net/http・gorilla mux: mux.HandleFunc("/path", h) / .Methods("GET")
    const handleRe = /\b(\w+)\.(?:HandleFunc|Handle)\(\s*"([^"]*)"\s*,\s*([^,)\n]+)/g;
    for (let m = handleRe.exec(noComments); m; m = handleRe.exec(noComments)) {
      const { method, path } = splitPattern(m[2]);
      if (!path.startsWith('/')) continue;
      const tail = noComments.slice(handleRe.lastIndex, handleRe.lastIndex + 200);
      const methodsCall = /^\s*\)?\s*\.Methods\(([^)]*)\)/.exec(tail);
      const methods = methodsCall
        ? (methodsCall[1].match(/"([A-Z]+)"/g) ?? []).map((s) => s.replace(/"/g, ''))
        : method
          ? [method]
          : ['ANY'];
      for (const mm of methods) addRoute(mm, path, m.index, m[1], m[3].trim());
    }
  }

  // クライアント: http.Get("url") / http.NewRequest(ctx, "POST", url, ...) / x.Get(url)
  const clientRe = /\bhttp\.(Get|Post|Head|PostForm|NewRequest|NewRequestWithContext)\s*\(/g;
  for (let m = clientRe.exec(noComments); m; m = clientRe.exec(noComments)) {
    const args = argsOf(noComments, clientRe.lastIndex - 1);
    const raw = urlLiteralOf(args);
    if (!raw) continue;
    const kind = m[1];
    const method =
      kind === 'Get' ? 'GET' : kind === 'Post' || kind === 'PostForm' ? 'POST' : kind === 'Head' ? 'HEAD' : goMethodLiteral(args);
    calls.push({ ...(method ? { method } : {}), raw, file, line: lineOf(m.index), ...(hostOf(raw) ? { host: hostOf(raw)! } : {}) });
  }
  // resty 風: client.R().Get("https://...") — 絶対 URL のときだけ拾う
  const restyRe = /\.(Get|Post|Put|Patch|Delete)\(\s*(["`])([a-zA-Z][\w+.-]*:\/\/[^"`]+)\2/g;
  for (let m = restyRe.exec(noComments); m; m = restyRe.exec(noComments)) {
    calls.push({
      method: m[1].toUpperCase(),
      raw: m[3],
      file,
      line: lineOf(m.index),
      ...(hostOf(m[3]) ? { host: hostOf(m[3])! } : {}),
    });
  }
}

/* ---------------- TypeScript / JavaScript ---------------- */

function scanJs(src: string, file: string, routes: RouteRec[], calls: CallRec[]): void {
  const { noComments } = stripSource(src, 'js');
  const lineOf = makeLineFinder(src);
  const serverish = /(from|require\()\s*['"](express|fastify|hono|@hono\/[\w-]+|koa|@koa\/router)['"]/.test(noComments);
  const framework = /express/.test(noComments)
    ? 'express'
    : /fastify/.test(noComments)
      ? 'fastify'
      : /hono/.test(noComments)
        ? 'hono'
        : 'koa';

  // app.use('/api', router) のプレフィックス(同一ファイル内のみ解決)
  const usePrefix = new Map<string, string>();
  const useRe = /\b(\w+)\.use\(\s*(['"`])(\/[^'"`]*)\2\s*,\s*(\w+)/g;
  for (let m = useRe.exec(noComments); m; m = useRe.exec(noComments)) usePrefix.set(m[4], m[3]);

  if (serverish) {
    const routeRe = /\b(\w+)\.(get|post|put|patch|delete|head|options|all)\(\s*(['"`])([^'"`]*)\3\s*,/g;
    for (let m = routeRe.exec(noComments); m; m = routeRe.exec(noComments)) {
      const path = m[4];
      if (!path.startsWith('/')) continue;
      const rest = noComments.slice(routeRe.lastIndex, routeRe.lastIndex + 120);
      const handler = /^\s*([\w.$]+)\s*[),]/.exec(rest)?.[1];
      const inline = !handler && /^\s*(async\b|function\b|\(|\{)/.test(rest);
      routes.push({
        method: m[2] === 'all' ? 'ANY' : m[2].toUpperCase(),
        path: (usePrefix.get(m[1]) ?? '') + path,
        file,
        line: lineOf(m.index),
        framework,
        ...(handler ? { handler } : {}),
        ...(inline ? { inline: true } : {}),
      });
    }
    // fastify.route({ method: 'GET', url: '/x' })
    const objRe = /\.route\(\s*\{/g;
    for (let m = objRe.exec(noComments); m; m = objRe.exec(noComments)) {
      const args = argsOf(noComments, objRe.lastIndex - 1);
      const url = /\burl\s*:\s*(['"`])([^'"`]*)\1/.exec(args)?.[2];
      const method = methodInOptions(args) ?? 'ANY';
      if (url && url.startsWith('/')) {
        routes.push({ method, path: url, file, line: lineOf(m.index), framework: 'fastify' });
      }
    }
  }

  // Next.js App Router: app/**/route.ts が export した GET/POST/... がそのままルート
  const nextMatch = /(?:^|\/)app\/(.+)\/route\.(?:ts|tsx|js|jsx|mjs)$/.exec(file);
  if (nextMatch) {
    const path = '/' + nextMatch[1].replace(/\(([^)]*)\)\//g, '').replace(/\[\.{3}?([^\]]+)\]/g, '{}').replace(/\[([^\]]+)\]/g, '{}');
    const expRe = /export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\b/g;
    for (let m = expRe.exec(noComments); m; m = expRe.exec(noComments)) {
      routes.push({ method: m[1], path, file, line: lineOf(m.index), framework: 'next', handler: m[1] });
    }
  }

  // クライアント: fetch(...) / axios.get(...) / axios({url, method})
  const fetchRe = /\bfetch\s*\(/g;
  for (let m = fetchRe.exec(noComments); m; m = fetchRe.exec(noComments)) {
    const args = argsOf(noComments, fetchRe.lastIndex - 1);
    const raw = urlLiteralOf(args);
    if (!raw) continue;
    const method = methodInOptions(args) ?? 'GET';
    calls.push({ method, raw, file, line: lineOf(m.index), ...(hostOf(raw) ? { host: hostOf(raw)! } : {}) });
  }
  const axiosRe = /\b(?:axios|http|https|api|client|request)\w*\.(get|post|put|patch|delete|head)\(\s*(['"`])([^'"`]*)\2/gi;
  for (let m = axiosRe.exec(noComments); m; m = axiosRe.exec(noComments)) {
    const raw = m[3];
    if (!raw.startsWith('/') && !/^[a-zA-Z][\w+.-]*:\/\//.test(raw) && !/^\$?\{[^}]*\}\//.test(raw)) continue;
    calls.push({ method: m[1].toUpperCase(), raw, file, line: lineOf(m.index), ...(hostOf(raw) ? { host: hostOf(raw)! } : {}) });
  }
}

/* ---------------- Python ---------------- */

function scanPy(src: string, file: string, routes: RouteRec[], calls: CallRec[]): void {
  const lineOf = makeLineFinder(src);
  const lines = src.split('\n');
  // APIRouter(prefix="/api")
  const prefixOf = new Map<string, string>();
  const routerRe = /\b(\w+)\s*=\s*APIRouter\(([^)]*)\)/g;
  for (let m = routerRe.exec(src); m; m = routerRe.exec(src)) {
    const p = /prefix\s*=\s*["']([^"']*)["']/.exec(m[2]);
    if (p) prefixOf.set(m[1], p[1]);
  }
  const includeRe = /\binclude_router\(\s*(\w+)[^)]*prefix\s*=\s*["']([^"']*)["']/g;
  for (let m = includeRe.exec(src); m; m = includeRe.exec(src)) {
    prefixOf.set(m[1], (prefixOf.get(m[1]) ?? '') + m[2]);
  }

  const decoRe = /@(\w+)\.(get|post|put|patch|delete|head|options|route)\(\s*["']([^"']*)["']([^)]*)\)/g;
  for (let m = decoRe.exec(src); m; m = decoRe.exec(src)) {
    const path = m[3];
    const prefix = prefixOf.get(m[1]) ?? '';
    // パスが "" でも APIRouter(prefix="/shipments") があればプレフィックス自体がルート
    if (!path.startsWith('/') && !(path === '' && prefix !== '')) continue;
    const line = lineOf(m.index);
    // 直後の def がハンドラ
    let handler: string | undefined;
    for (let i = line; i < Math.min(lines.length, line + 6); i++) {
      const d = /^\s*(?:async\s+)?def\s+(\w+)/.exec(lines[i]);
      if (d) {
        handler = d[1];
        break;
      }
    }
    const methods =
      m[2] === 'route'
        ? (m[4].match(/["'](GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)["']/g) ?? ['"GET"']).map((s) => s.replace(/["']/g, ''))
        : [m[2].toUpperCase()];
    for (const method of methods) {
      routes.push({
        method,
        path: prefix + path,
        file,
        line,
        framework: /Flask/.test(src) ? 'flask' : 'fastapi',
        ...(handler ? { handler } : {}),
      });
    }
  }

  const clientRe = /\b(?:requests|httpx|session|client)\.(get|post|put|patch|delete|head)\(\s*f?(["'])([^"']*)\2/gi;
  for (let m = clientRe.exec(src); m; m = clientRe.exec(src)) {
    const raw = m[3];
    if (!raw.startsWith('/') && !/^[a-zA-Z][\w+.-]*:\/\//.test(raw) && !/^\{[^}]*\}\//.test(raw)) continue;
    calls.push({ method: m[1].toUpperCase(), raw, file, line: lineOf(m.index), ...(hostOf(raw) ? { host: hostOf(raw)! } : {}) });
  }
}

/* ---------------- Elixir(Phoenix Router) ---------------- */

function scanEx(src: string, file: string, routes: RouteRec[]): void {
  if (!/use\s+\w+\s*,\s*:router|use\s+Phoenix\.Router/.test(src)) return;
  const lineOf = makeLineFinder(src);
  const re = /^\s*(get|post|put|patch|delete|head|options)\s+"([^"]+)"\s*,\s*([\w.]+)\s*,\s*:(\w+)/gm;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    routes.push({
      method: m[1].toUpperCase(),
      path: m[2],
      file,
      line: lineOf(m.index),
      framework: 'phoenix',
      handler: m[3] + '.' + m[4],
      note: `${m[3]}.${m[4]}`,
    });
  }
  // LiveView: live "/products", ProductLive.Index
  const liveRe = /^\s*live\s+"([^"]+)"\s*,\s*([\w.]+)(?:\s*,\s*:(\w+))?/gm;
  for (let m = liveRe.exec(src); m; m = liveRe.exec(src)) {
    routes.push({
      method: 'GET',
      path: m[1],
      file,
      line: lineOf(m.index),
      framework: 'phoenix-live',
      handler: m[2],
      note: m[2] + (m[3] ? '.' + m[3] : ''),
    });
  }
}

/* ---------------- 本体 ---------------- */

export function detectHttp(ctx: Ctx): void {
  if (ctx.config.http?.enabled === false) return;
  const funcIndex = buildFuncIndex(ctx);
  const routes: RouteRec[] = [];
  const calls: CallRec[] = [];

  for (const project of ctx.projects) {
    const read = (rel: string): string | undefined => {
      try {
        return readFileText(ctx, rel);
      } catch {
        return undefined;
      }
    };
    for (const rel of project.goFiles) {
      const src = read(rel);
      if (src) scanGo(src, rel, routes, calls);
    }
    for (const rel of project.jsFiles) {
      const src = read(rel);
      if (src) scanJs(src, rel, routes, calls);
    }
    for (const rel of project.pyFiles) {
      const src = read(rel);
      if (src) scanPy(src, rel, routes, calls);
    }
    for (const rel of project.exFiles) {
      const src = read(rel);
      if (src) scanEx(src, rel, routes);
    }
  }
  if (routes.length === 0 && calls.length === 0) return;

  // ルートノードを作る
  const byKey = new Map<string, string[]>(); // "METHOD /path" -> route node ids
  const byPath = new Map<string, string[]>(); // "/path" -> route node ids
  const webhookPatterns = ctx.config.http?.webhookPatterns ?? [];
  const isWebhook = (r: RouteRec): boolean =>
    looksLikeWebhook(r.path) || webhookPatterns.some((p) => r.path.includes(p));

  const routeIds: Array<{ id: string; rec: RouteRec }> = [];
  for (const rec of routes) {
    const owner = enclosingNodeId(ctx, funcIndex, rec.file, rec.line);
    const parent = (owner && ctx.builder.get(owner)?.parent) || owner || '';
    if (!parent) continue;
    const norm = normalizePath(rec.path);
    const id = `route:${parent}#${rec.method} ${norm}`;
    const label = `${rec.method} ${norm}`;
    ctx.builder.addNode({
      id,
      label,
      parent,
      kind: 'route',
      lang: 'http',
      meta: {
        file: rec.file,
        line: rec.line,
        method: rec.method,
        path: norm,
        framework: rec.framework,
        ...(rec.inline ? { inlineHandler: true } : {}),
        ...(isWebhook(rec) ? { webhook: true } : {}),
        ...(rec.note ? { doc: rec.note } : {}),
      },
    });
    routeIds.push({ id, rec });
    const k = pathKey(rec.method, rec.path);
    const pk = normalizePath(rec.path).toLowerCase();
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k)!.push(id);
    if (!byPath.has(pk)) byPath.set(pk, []);
    byPath.get(pk)!.push(id);
  }

  // ハンドラ実装への impl 辺(同一サービス内で名前が一意に決まるときだけ)
  const funcByName = new Map<string, string[]>();
  for (const node of ctx.builder.nodes.values()) {
    if (node.kind !== 'func') continue;
    const short = node.label.includes('.') ? node.label.slice(node.label.lastIndexOf('.') + 1) : node.label;
    if (!funcByName.has(short)) funcByName.set(short, []);
    funcByName.get(short)!.push(node.id);
  }
  for (const { id, rec } of routeIds) {
    if (!rec.handler) continue;
    const parts = rec.handler.replace(/[()]/g, '').split('.');
    const short = parts.pop() ?? '';
    const qualifier = parts.pop(); // 例: users.Get の "users"
    if (short === '') continue;
    const svc = topAncestorId(ctx, id);
    let candidates = (funcByName.get(short) ?? []).filter((fid) => topAncestorId(ctx, fid) === svc);
    if (candidates.length > 1 && qualifier) {
      // Get のような汎用名は複数のハンドラ型に存在する。レシーバ変数名(users)と
      // レシーバ型名(UserHandler)の緩い一致で絞る。単複の揺れも許容する
      const q = qualifier.toLowerCase().replace(/s$/, '');
      const narrowed = candidates.filter((fid) => {
        const label = ctx.builder.get(fid)?.label ?? '';
        const recv = label.includes('.') ? label.slice(0, label.indexOf('.')).toLowerCase() : '';
        return recv !== '' && (recv.includes(q) || q.includes(recv.replace(/handler|controller|api$/g, '')));
      });
      if (narrowed.length === 1) candidates = narrowed;
    }
    if (candidates.length === 1) ctx.builder.addEdge(id, candidates[0], 'impl');
  }

  // webhook 受信口には外部からの入りを表す辺を張る
  const webhookRoutes = routeIds.filter(({ rec }) => isWebhook(rec));
  if (webhookRoutes.length > 0) {
    ctx.builder.addNode({ id: EXT_IN_ID, label: '外部からの受信(HTTP)', kind: 'service', lang: 'http' });
    const inId = EXT_IN_ID + ':webhook';
    ctx.builder.addNode({
      id: inId,
      label: 'Webhook 送信元',
      parent: EXT_IN_ID,
      kind: 'route',
      lang: 'http',
      meta: { external: true, webhook: true },
    });
    for (const { id } of webhookRoutes) ctx.builder.addEdge(inId, id, 'http');
  }

  // クライアント呼び出しの解決
  for (const call of calls) {
    const from = enclosingNodeId(ctx, funcIndex, call.file, call.line);
    if (!from) continue;
    const site = { f: call.file, l: call.line };
    const key = call.method ? pathKey(call.method, call.raw) : '';
    const pk = normalizePath(call.raw).toLowerCase();
    let targets = key ? (byKey.get(key) ?? []) : [];
    if (targets.length === 0) targets = byPath.get(pk) ?? [];
    if (targets.length === 1) {
      ctx.builder.addEdge(from, targets[0], 'http', 1, site);
      continue;
    }
    if (targets.length > 1) continue; // 曖昧: 誤接続を避けて張らない
    // どのルートにも当たらない絶対 URL は「外部システム」への送信として残す
    if (call.host && ctx.config.http?.externalHosts !== false) {
      ctx.builder.addNode({ id: EXT_OUT_ID, label: '外部への送信(HTTP)', kind: 'service', lang: 'http' });
      const extId = `${EXT_OUT_ID}:${call.host}`;
      ctx.builder.addNode({
        id: extId,
        label: call.host,
        parent: EXT_OUT_ID,
        kind: 'route',
        lang: 'http',
        meta: { external: true, ...(looksLikeWebhook(call.raw) ? { webhook: true } : {}) },
      });
      ctx.builder.addEdge(from, extId, 'http', 1, site);
    }
  }
}
