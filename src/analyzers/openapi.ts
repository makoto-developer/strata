// OpenAPI / Swagger の仕様書を「API 定義」として取り込む。
//
// proto に対する rpc ノードと同じ位置づけ。コードから見つけた route ノードが「実装」で、
// 仕様書の paths が「宣言」。両者を突き合わせると、このツールがいちばん出したい
// 「宣言と実装のずれ」がそのまま見える:
//
//   宣言あり・実装なし → 未実装、別サービスの担当、あるいは仕様書が古い
//   実装あり・宣言なし → 未文書化(仕様書を持つサービスに限って報告する)
//
// 汎用の YAML パーサは持たない(ゼロ依存のため)。読むのは paths の 2 階層と
// operationId / summary / deprecated だけ。$ref も anchors も解決しない。
// 読めなかったものは推測で埋めず、警告に出して落とす。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx, Project } from '../context.ts';
import { setEvidence } from '../model.ts';
import { normalizePath, pathKey } from './endpoints.ts';

const METHODS = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
const SNIFF_BYTES = 4096; // 仕様書かどうかの判定に読む先頭バイト数
const MAX_SPEC_BYTES = 8 * 1024 * 1024;

/** 仕様書らしいファイル名(中身を読まずに判定できる速い経路)。 */
export function looksLikeSpecName(base: string): boolean {
  return /(^|[._-])(openapi|swagger)([._-]|$)/i.test(base.replace(/\.(ya?ml|json)$/i, ''));
}

/**
 * 中身の先頭を見て OpenAPI / Swagger か判定する。
 * ファイル名が api.yaml や v1.yaml のこともあるので、名前だけでは足りない。
 */
export function sniffSpec(text: string): boolean {
  return /^\s*"?(openapi|swagger)"?\s*:\s*["']?\d/m.test(text.slice(0, SNIFF_BYTES));
}

export interface DeclaredOp {
  method: string;
  rawPath: string; // 仕様書に書いてあるまま
  operationId?: string;
  summary?: string;
  deprecated?: boolean;
}

export interface ParsedSpec {
  title?: string;
  version?: string;
  basePath?: string; // swagger 2 の basePath / openapi 3 の servers[0] のパス部分
  ops: DeclaredOp[];
}

const unquote = (raw: string): string => {
  const s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))
    return s.slice(1, -1);
  return s;
};

/** JSON の仕様書。YAML より確実なので先に試す。 */
function parseJsonSpec(text: string): ParsedSpec | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!doc || typeof doc !== 'object') return undefined;
  const root = doc as Record<string, unknown>;
  if (root.openapi === undefined && root.swagger === undefined) return undefined;
  const info = (root.info ?? {}) as Record<string, unknown>;
  const servers = Array.isArray(root.servers) ? (root.servers as Array<Record<string, unknown>>) : [];
  const serverUrl = typeof servers[0]?.url === 'string' ? (servers[0].url as string) : undefined;
  const ops: DeclaredOp[] = [];
  const paths = (root.paths ?? {}) as Record<string, unknown>;
  for (const [rawPath, item] of Object.entries(paths)) {
    if (!rawPath.startsWith('/') || !item || typeof item !== 'object') continue;
    for (const [method, op] of Object.entries(item as Record<string, unknown>)) {
      if (!METHODS.has(method.toLowerCase())) continue;
      const o = (op ?? {}) as Record<string, unknown>;
      ops.push({
        method: method.toUpperCase(),
        rawPath,
        ...(typeof o.operationId === 'string' ? { operationId: o.operationId } : {}),
        ...(typeof o.summary === 'string' ? { summary: o.summary } : {}),
        ...(o.deprecated === true ? { deprecated: true } : {}),
      });
    }
  }
  return {
    ...(typeof info.title === 'string' ? { title: info.title } : {}),
    ...(typeof info.version === 'string' ? { version: info.version } : {}),
    ...basePathOf(typeof root.basePath === 'string' ? root.basePath : undefined, serverUrl),
    ops,
  };
}

/**
 * servers[0].url からパス部分だけを取り出す。
 * 汎用の normalizePath は使えない: `{scheme}://{host}/v1` のような変数入りを
 * URL と認識できず、`/{}:/{}/v1` という実在しない基底パスを作ってしまう。
 */
function serverBasePath(url: string): string | undefined {
  const raw = url.trim();
  if (raw === '') return undefined;
  let rest: string;
  const authority = /^(?:[A-Za-z][\w+.-]*|\{[^}]*\}):\/\/([^/]*)(\/.*)?$/.exec(raw);
  if (authority) rest = authority[2] ?? '';
  else if (raw.startsWith('/')) rest = raw; // 相対 URL(/api/v1)
  else return undefined; // ホストだけ、あるいは解釈できない形。推測で基底パスを作らない
  const p = normalizePath(rest);
  return p === '/' || p === '' ? undefined : p;
}

function basePathOf(swaggerBase?: string, serverUrl?: string): { basePath?: string } {
  if (swaggerBase && swaggerBase !== '/') return { basePath: swaggerBase.replace(/\/+$/, '') };
  if (!serverUrl) return {};
  const p = serverBasePath(serverUrl);
  return p === undefined ? {} : { basePath: p };
}

/**
 * YAML の仕様書。インデントだけを頼りに paths の 2 階層を読む。
 * ブロックスカラーやフロー記法(`{get: {...}}`)は扱わない — 仕様書では稀なため、
 * 読めなければ「読めなかった」として扱い、推測はしない。
 */
function parseYamlSpec(whole: string): ParsedSpec | undefined {
  if (!sniffSpec(whole)) return undefined;
  // 複数文書(--- 区切り)のうち、トップレベルに openapi/swagger を持つ文書だけを読む。
  // 全体を 1 枚と見なすと、別文書の paths から存在しないエンドポイントを作る
  const text = pickSpecDocument(whole);
  if (text === undefined) return undefined;
  const lines = text.split('\n');
  const indentOf = (line: string): number => line.length - line.replace(/^ +/, '').length;
  const keyOf = (line: string): { key: string; value: string } | undefined => {
    const m = /^\s*("[^"]*"|'[^']*'|[^:#]+?)\s*:(?:\s+(.*))?$/.exec(line);
    if (!m) return undefined;
    return { key: unquote(m[1]), value: unquote((m[2] ?? '').replace(/\s+#.*$/, '')) };
  };

  let title: string | undefined;
  let version: string | undefined;
  let swaggerBase: string | undefined;
  let serverUrl: string | undefined;
  const ops: DeclaredOp[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const kv = keyOf(line);
    if (!kv) continue;
    const ind = indentOf(line);

    if (ind === 0 && kv.key === 'basePath' && kv.value !== '') swaggerBase = kv.value;
    if (ind === 0 && kv.key === 'info') {
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > 0); j++) {
        const sub = keyOf(lines[j]);
        if (!sub) continue;
        if (sub.key === 'title' && title === undefined) title = sub.value;
        if (sub.key === 'version' && version === undefined) version = sub.value;
      }
    }
    if (ind === 0 && kv.key === 'servers') {
      for (let j = i + 1; j < lines.length && (lines[j].trim() === '' || indentOf(lines[j]) > 0); j++) {
        const m = /^\s*-?\s*url\s*:\s*(.+)$/.exec(lines[j]);
        if (m) {
          serverUrl = unquote(m[1].replace(/\s+#.*$/, ''));
          break; // 最初のサーバだけ見る(複数環境の差はパスに出ないのが普通)
        }
      }
    }
    if (ind !== 0 || kv.key !== 'paths') continue;

    // paths の中。子インデント = パス、その子 = メソッド
    let pathIndent = -1;
    let curPath: string | undefined;
    let methodIndent = -1;
    let cur: DeclaredOp | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (l.trim() === '' || l.trimStart().startsWith('#')) continue;
      const ind2 = indentOf(l);
      if (ind2 === 0) break; // paths ブロックの終わり
      const kv2 = keyOf(l);
      if (!kv2) continue;
      if (pathIndent < 0) pathIndent = ind2;
      if (ind2 === pathIndent) {
        curPath = kv2.key.startsWith('/') ? kv2.key : undefined;
        methodIndent = -1;
        cur = undefined;
        continue;
      }
      if (curPath === undefined) continue;
      if (methodIndent < 0 && ind2 > pathIndent) methodIndent = ind2;
      if (ind2 === methodIndent) {
        if (!METHODS.has(kv2.key.toLowerCase())) {
          cur = undefined; // parameters / summary など、メソッド以外の兄弟キー
          continue;
        }
        cur = { method: kv2.key.toUpperCase(), rawPath: curPath };
        ops.push(cur);
        continue;
      }
      if (cur && ind2 > methodIndent) {
        if (kv2.key === 'operationId' && kv2.value !== '') cur.operationId = kv2.value;
        else if (kv2.key === 'summary' && kv2.value !== '') cur.summary = kv2.value;
        else if (kv2.key === 'deprecated' && kv2.value === 'true') cur.deprecated = true;
      }
    }
    break; // paths は 1 つ
  }
  return { ...(title ? { title } : {}), ...(version ? { version } : {}), ...basePathOf(swaggerBase, serverUrl), ops };
}

/** --- / ... で区切られた文書のうち、仕様書本体を返す。無ければ undefined。 */
function pickSpecDocument(text: string): string | undefined {
  const docs: string[] = [];
  let cur: string[] = [];
  for (const line of text.split('\n')) {
    if (/^(---|\.\.\.)\s*$/.test(line)) {
      docs.push(cur.join('\n'));
      cur = [];
      continue;
    }
    cur.push(line);
  }
  docs.push(cur.join('\n'));
  const isSpec = (d: string): boolean => /^\s{0,2}"?(openapi|swagger)"?\s*:\s*["']?\d/m.test(d);
  const hit = docs.filter(isSpec);
  if (hit.length === 1) return hit[0];
  if (hit.length > 1) return undefined; // どれが本体か決められない。推測しない
  return docs.length === 1 ? docs[0] : undefined;
}

export function parseSpec(text: string): ParsedSpec | undefined {
  return parseJsonSpec(text) ?? parseYamlSpec(text);
}

/** 仕様書ファイルかを名前と中身で判定する(scan からファイル振り分けに使う)。 */
export function isSpecFile(absPath: string, rel: string): boolean {
  const base = path.posix.basename(rel);
  if (!/\.(ya?ml|json)$/i.test(base)) return false;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile() || st.size > MAX_SPEC_BYTES) return false;
    if (looksLikeSpecName(base)) return true;
    const fd = fs.openSync(absPath, 'r');
    try {
      const buf = Buffer.alloc(SNIFF_BYTES);
      const read = fs.readSync(fd, buf, 0, SNIFF_BYTES, 0);
      return sniffSpec(buf.subarray(0, read).toString('utf8'));
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

/**
 * 宣言された API を登録する。detectHttp より先に呼ぶ:
 * 呼び出し側の解決で、コードに実装が無い宣言済みエンドポイントも候補にするため。
 */
export function registerOpenapi(ctx: Ctx, projects: Project[]): void {
  if (ctx.config.openapi?.enabled === false) return;
  for (const project of projects) {
    for (const wsRel of project.openapiFiles) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(ctx.rootAbs, wsRel), 'utf8');
      } catch {
        continue;
      }
      let spec: ParsedSpec | undefined;
      try {
        spec = parseSpec(text);
      } catch (e) {
        ctx.builder.warn(`OpenAPI の解析に失敗しました(${(e as Error).message}): ${wsRel}`);
        continue; // 1 ファイルの異常でワークスペース全体の解析を止めない
      }
      if (!spec) {
        ctx.builder.warn(`OpenAPI として読めませんでした: ${wsRel}`);
        continue;
      }
      if (spec.ops.length === 0) {
        ctx.builder.warn(`OpenAPI の paths を読めませんでした(フロー記法 / $ref?): ${wsRel}`);
        continue;
      }
      const parent = specParent(ctx, project, wsRel);
      ctx.builder.addNode({
        id: wsRel,
        label: path.posix.basename(wsRel),
        parent,
        kind: 'file',
        lang: 'openapi',
        meta: {
          file: wsRel,
          line: 1,
          spec: 'openapi',
          ...(spec.title ? { doc: spec.title + (spec.version ? ` (${spec.version})` : '') } : {}),
        },
      });
      for (const op of spec.ops) {
        const full = (spec.basePath ?? '') + op.rawPath;
        const norm = normalizePath(full);
        const id = `${wsRel}#${op.method} ${norm}`;
        ctx.builder.addNode({
          id,
          label: `${op.method} ${norm}`,
          parent: wsRel,
          kind: 'route',
          lang: 'openapi',
          meta: {
            file: wsRel,
            line: 1,
            method: op.method,
            path: norm,
            declared: true,
            ...(op.operationId ? { operationId: op.operationId } : {}),
            ...(op.summary ? { doc: op.summary } : {}),
            ...(op.deprecated ? { deprecated: true } : {}),
          },
        });
        const key = pathKey(op.method, full);
        let list = ctx.declaredRoutes.get(key);
        if (!list) {
          list = [];
          ctx.declaredRoutes.set(key, list);
        }
        list.push(id);
      }
    }
  }
}

/** 仕様書ノードの親。api/ や docs/ に置かれることが多いので、モジュールに寄せる。 */
function specParent(ctx: Ctx, project: Project, wsRel: string): string {
  if (project.nodeId !== '') return project.nodeId;
  const dir = path.posix.dirname(wsRel);
  return dir === '.' ? '' : ctx.builder.ensureDirChain(dir, '', '');
}

/**
 * 宣言と実装を突き合わせる。detectHttp の後に呼ぶ。
 * 繋がらなかったものは「ずれ」として警告に出す — 黙って消すと、この機能の意味が無い。
 */
export function linkOpenapi(ctx: Ctx): void {
  if (ctx.config.openapi?.enabled === false) return;
  if (ctx.declaredRoutes.size === 0) return;

  // コード側のルートを method+path で引けるようにする。
  // メソッドを指定しない登録(mux.HandleFunc / app.use など)は ANY になるので、
  // パスだけの索引にも入れて、宣言のどのメソッドとも照合できるようにする
  const codeByKey = new Map<string, string[]>();
  const codeAnyByPath = new Map<string, string[]>();
  const allCode: string[] = [];
  const specServices = new Set<string>();
  const push = (map: Map<string, string[]>, key: string, id: string): void => {
    let list = map.get(key);
    if (!list) {
      list = [];
      map.set(key, list);
    }
    list.push(id);
  };
  for (const n of ctx.builder.nodes.values()) {
    if (n.kind !== 'route') continue;
    const meta = n.meta ?? {};
    if (meta.declared === true) {
      specServices.add(topOf(ctx, n.id));
      continue;
    }
    if (meta.external === true || typeof meta.method !== 'string' || typeof meta.path !== 'string') continue;
    allCode.push(n.id);
    if (meta.method.toUpperCase() === 'ANY') push(codeAnyByPath, normalizePath(meta.path).toLowerCase(), n.id);
    else push(codeByKey, pathKey(meta.method, meta.path), n.id);
  }

  const implemented = new Set<string>();
  const missingImpl: string[] = [];
  // 仕様書だけを置くサービス(中央のスキーマリポジトリ)は、実装が他サービスにある
  const svcHasCode = new Set(allCode.map((id) => topOf(ctx, id)));
  for (const [key, declaredIds] of ctx.declaredRoutes) {
    const declPath = key.slice(key.indexOf(' ') + 1);
    const exact = codeByKey.get(key) ?? [];
    const anyMethod = codeAnyByPath.get(declPath) ?? [];
    for (const declId of declaredIds) {
      // パスだけで照合すると、どのサービスにもある GET /health が他サービスの実装に繋がる。
      // 嘘の依存はこのツールで最悪の誤りなので、同じサービス内に限る。
      // 仕様書だけのサービスに限り、ワークスペース全体で一意なときだけまたぐ
      const svc = topOf(ctx, declId);
      const scope = (ids: string[]): string[] => {
        const same = ids.filter((id) => topOf(ctx, id) === svc);
        if (same.length > 0) return same;
        return !svcHasCode.has(svc) && ids.length === 1 ? ids : [];
      };
      const exactHit = scope(exact);
      // メソッド未指定の登録は「そのパスに何か生えている」以上のことを言っていない。
      // 宣言の全メソッドを実装している証拠ではないので、根拠を弱いほうに落とす
      const anyHit = exactHit.length > 0 ? [] : scope(anyMethod);
      if (exactHit.length === 0 && anyHit.length === 0) {
        missingImpl.push(labelOf(ctx, declId));
        continue;
      }
      for (const codeId of exactHit) {
        setEvidence(ctx.builder.addEdge(declId, codeId, 'impl'), 'configured');
        implemented.add(codeId);
      }
      for (const codeId of anyHit) {
        setEvidence(ctx.builder.addEdge(declId, codeId, 'impl'), 'name');
        implemented.add(codeId);
      }
    }
  }

  // 仕様書を持つサービスに限って、書かれていない実装を報告する。
  // 仕様書が無いサービスまで対象にすると、ほぼ全ルートが警告になって読めない
  const missingDecl: string[] = [];
  for (const id of allCode) {
    if (implemented.has(id)) continue;
    if (!specServices.has(topOf(ctx, id))) continue;
    missingDecl.push(labelOf(ctx, id));
  }
  // 1 件 1 警告にすると、仕様書が古いだけで数千行になって他の警告が読めなくなる
  warnDrift(ctx, '宣言だけで実装が見つかりません(OpenAPI)', missingImpl);
  warnDrift(ctx, '実装だけで宣言が見つかりません(OpenAPI)', missingDecl);
}

function topOf(ctx: Ctx, id: string): string {
  let cur = id;
  for (let i = 0; i < 64; i++) {
    const parent = ctx.builder.get(cur)?.parent;
    if (!parent) return cur;
    cur = parent;
  }
  return cur;
}

function labelOf(ctx: Ctx, id: string): string {
  const n = ctx.builder.get(id);
  return n ? `${topOf(ctx, id)} ${n.label}` : id;
}

const DRIFT_SHOWN = 5;

function warnDrift(ctx: Ctx, head: string, items: string[]): void {
  if (items.length === 0) return;
  const sorted = [...items].sort();
  const shown = sorted.slice(0, DRIFT_SHOWN).join(', ');
  ctx.builder.warn(
    `${head}: ${sorted.length} 件 — ${shown}` +
      (sorted.length > DRIFT_SHOWN ? ` ほか ${sorted.length - DRIFT_SHOWN} 件` : ''),
  );
}
