// Go 解析(docs/SPEC.md §5.2, §6.2)
// パッケージ単位の構造 + 関数宣言 + 呼び出し解決。Go ツールチェーン不要のテキスト解析。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chainBase, readFileText, type Ctx, type Project } from '../context.ts';
import { countLines, leadingComment, makeLineFinder, matchBrace, stripSource } from '../lex.ts';

interface GoFunc {
  id: string;
  name: string;
  recv?: string;
  bodyStart: number;
  bodyEnd: number;
}

interface GoFileInfo {
  wsRel: string;
  pkgId: string;
  aliases: Map<string, string>; // 別名 -> import パス
  importPaths: string[]; // 出現ごと(重複含む)
  functions: GoFunc[];
  blanked: string;
}

export interface GoState {
  project: Project;
  files: GoFileInfo[];
}

const GO_KEYWORDS = new Set([
  'break', 'case', 'chan', 'const', 'continue', 'default', 'defer', 'else',
  'fallthrough', 'for', 'func', 'go', 'goto', 'if', 'import', 'interface',
  'map', 'package', 'range', 'return', 'select', 'struct', 'switch', 'type', 'var',
]);
const GO_BUILTINS = new Set([
  'make', 'new', 'len', 'cap', 'append', 'copy', 'delete', 'panic', 'recover',
  'print', 'println', 'close', 'min', 'max', 'clear', 'complex', 'real', 'imag',
  'string', 'bool', 'byte', 'rune', 'error', 'any',
  'int', 'int8', 'int16', 'int32', 'int64',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uintptr',
  'float32', 'float64', 'complex64', 'complex128',
]);

function defaultAlias(importPath: string): string {
  const segments = importPath.split('/');
  let last = segments[segments.length - 1];
  if (/^v\d+$/.test(last) && segments.length > 1) last = segments[segments.length - 2];
  return last;
}

export function parseImports(noComments: string): Array<{ alias?: string; path: string }> {
  const result: Array<{ alias?: string; path: string }> = [];
  const singleRe = /^import\s+(?:([\w.]+)\s+)?"([^"]+)"/gm;
  let m: RegExpExecArray | null;
  while ((m = singleRe.exec(noComments)) !== null) {
    result.push({ alias: m[1], path: m[2] });
  }
  const blockRe = /^import\s*\(/gm;
  while ((m = blockRe.exec(noComments)) !== null) {
    const start = blockRe.lastIndex;
    const end = noComments.indexOf(')', start);
    if (end < 0) continue;
    const body = noComments.slice(start, end);
    const lineRe = /^\s*(?:([\w.]+)\s+)?"([^"]+)"/gm;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(body)) !== null) {
      result.push({ alias: lm[1], path: lm[2] });
    }
  }
  return result;
}

/** 関数シグネチャの後ろから本体の '{' を探す(括弧の深さ 0 で最初に現れるもの)。 */
export function findBodyOpen(blanked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '{' && depth <= 0) return i;
    else if (ch === '}' && depth <= 0) return -1; // 本体なし宣言など
  }
  return -1;
}

/** open('(' の位置)に対応する ')' の位置を返す。見つからなければ -1。 */
function matchParen(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if (s[i] === '(') depth++;
    else if (s[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * gRPC サーバのインターセプタ登録を検出して、その表示名の一覧を返す。
 * `grpc.UnaryInterceptor(x)` / `grpc.ChainUnaryInterceptor(a, b, ...)`(stream 版も)
 * のオプション構築子から、引数(インターセプタ関数・生成関数)の名前を取り出す。
 * blanked(文字列無害化済み)を渡すこと。認可などの横断ミドルウェアはコールグラフに
 * 出ないため、これを別途拾ってサービスに付与する(docs/SPEC.md §6.8 の補完)。
 */
export function extractInterceptors(blanked: string): string[] {
  const out: string[] = [];
  // クライアント側 grpc.WithUnaryInterceptor は語境界の関係で一致しない(サーバ側だけ拾う)
  const optRe = /\b(?:Chain)?(?:Unary|Stream)Interceptor\s*\(/g;
  for (let m = optRe.exec(blanked); m; m = optRe.exec(blanked)) {
    const open = optRe.lastIndex - 1; // '(' の位置
    const close = matchParen(blanked, open);
    if (close < 0) continue;
    const inside = blanked.slice(open + 1, close);
    // トップレベルのカンマで引数分割(ネストした () [] {} は無視)
    let depth = 0;
    let start = 0;
    const args: string[] = [];
    for (let i = 0; i < inside.length; i++) {
      const c = inside[i];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') depth--;
      else if (c === ',' && depth === 0) {
        args.push(inside.slice(start, i));
        start = i + 1;
      }
    }
    args.push(inside.slice(start));
    for (const a of args) {
      // `auth.UnaryServerInterceptor(cfg)` → `auth.UnaryServerInterceptor`
      const name = a.split('(')[0].trim();
      if (name && !out.includes(name)) out.push(name);
    }
  }
  return out;
}

/** ノードの最上位祖先(サービス/モジュールの根)を返す。 */
function topAncestorId(ctx: Ctx, id: string): string {
  let cur = id;
  for (;;) {
    const node = ctx.builder.get(cur);
    if (!node || !node.parent) return cur;
    cur = node.parent;
  }
}

export function receiverType(recvRaw: string): string | undefined {
  const cleaned = recvRaw.replace(/\[[^\]]*\]/g, '').trim();
  if (cleaned === '') return undefined;
  const parts = cleaned.split(/\s+/);
  const typePart = parts[parts.length - 1].replace(/^\*+/, '');
  const m = typePart.match(/([A-Za-z_]\w*)$/);
  return m ? m[1] : undefined;
}

export function registerGo(ctx: Ctx, project: Project): GoState {
  const state: GoState = { project, files: [] };
  if (project.goFiles.length === 0) return state;

  // gRPC サーバのインターセプタ(認可などの横断ミドルウェア)をサービス単位で集める
  const interceptors: string[] = [];
  let interceptorAnchor = ''; // 登録が見つかったパッケージ(サービス根の算出用)

  let modPath: string | undefined;
  if (project.hasGo) {
    try {
      const goMod = fs.readFileSync(path.join(ctx.rootAbs, project.rootRel, 'go.mod'), 'utf8');
      const m = goMod.match(/^module\s+(\S+)/m);
      if (m) modPath = m[1];
    } catch {
      // go.mod が読めなくても構造解析は続行
    }
  }
  if (modPath) {
    const segments = modPath.split('/');
    if (segments.length >= 2) ctx.goModulePrefixes.add(segments[0] + '/' + segments[1]);
  }

  // ディレクトリ = パッケージ
  const filesByDir = new Map<string, string[]>();
  for (const wsRel of project.goFiles) {
    const dirname = path.posix.dirname(wsRel);
    const dir = dirname === '.' ? '' : dirname;
    let list = filesByDir.get(dir);
    if (!list) {
      list = [];
      filesByDir.set(dir, list);
    }
    list.push(wsRel);
  }

  const pkgIdOfDir = new Map<string, string>();
  for (const dir of [...filesByDir.keys()].sort()) {
    let pkgId: string;
    if (dir === project.rootRel && project.nodeId !== '') {
      pkgId = project.nodeId; // モジュールルート直下のパッケージはモジュールノードが兼ねる
    } else {
      const base = chainBase(ctx, project, dir);
      pkgId = ctx.builder.ensureDirChain(dir, base.baseWsRel, base.baseId);
      const node = ctx.builder.get(pkgId);
      if (node && node.kind === 'dir') {
        node.kind = 'package';
        node.lang = 'go';
      }
    }
    pkgIdOfDir.set(dir, pkgId);
    const relInModule =
      dir === project.rootRel ? '' : project.rootRel === '' ? dir : dir.slice(project.rootRel.length + 1);
    if (modPath) {
      const importPath = relInModule === '' ? modPath : modPath + '/' + relInModule;
      ctx.goPkgOfImportPath.set(importPath, pkgId);
    }
    if (relInModule !== '') {
      let entries = ctx.goPkgRelIndex.get(relInModule);
      if (!entries) {
        entries = [];
        ctx.goPkgRelIndex.set(relInModule, entries);
      }
      entries.push({ pkgId, project: project.nodeId });
    }
  }

  for (const [dir, files] of filesByDir) {
    const pkgId = pkgIdOfDir.get(dir)!;
    let funcIndex = ctx.goFuncsOfPkg.get(pkgId);
    if (!funcIndex) {
      funcIndex = new Map();
      ctx.goFuncsOfPkg.set(pkgId, funcIndex);
    }
    let methodIndex = ctx.goMethodsOfPkg.get(pkgId);
    if (!methodIndex) {
      methodIndex = new Map();
      ctx.goMethodsOfPkg.set(pkgId, methodIndex);
    }
    for (const wsRel of files) {
      const src = readFileText(ctx, wsRel);
      const { noComments, blanked } = stripSource(src, 'go');
      const lineOf = makeLineFinder(src);
      const srcLines = src.split('\n');
      ctx.builder.addLoc(pkgId, countLines(src));

      // gRPC インターセプタ登録(認可などの横断ミドルウェア)を拾う
      for (const name of extractInterceptors(blanked)) {
        if (!interceptors.includes(name)) interceptors.push(name);
        if (interceptorAnchor === '') interceptorAnchor = pkgId;
      }

      // 型宣言(ビューアの ⌘クリック定義ジャンプ用)。パッケージノードの meta に記録する
      {
        const pkgNode = ctx.builder.get(pkgId);
        if (pkgNode) {
          if (!pkgNode.meta) pkgNode.meta = {};
          const meta = pkgNode.meta;
          if (!meta.typeDefs) meta.typeDefs = {};
          const typeRe = /^type\s+(\w+)/gm;
          let tm: RegExpExecArray | null;
          while ((tm = typeRe.exec(noComments)) !== null) {
            if (meta.typeDefs[tm[1]] === undefined) meta.typeDefs[tm[1]] = { f: wsRel, l: lineOf(tm.index) };
          }
        }
      }

      const imports = parseImports(noComments);
      const aliases = new Map<string, string>();
      const importPaths: string[] = [];
      for (const imp of imports) {
        importPaths.push(imp.path);
        const alias = imp.alias ?? defaultAlias(imp.path);
        if (alias !== '_' && alias !== '.') aliases.set(alias, imp.path);
      }

      // gRPC サーバ実装の確度の高い証拠: 生成コードの Unimplemented<Service>Server 埋め込み。
      // クライアントラッパーが RPC と同名メソッドを持つ場合との誤認を防ぐ(linkGo で使用)
      {
        const embedRe = /\bUnimplemented(\w+)Server\b/g;
        let em: RegExpExecArray | null;
        while ((em = embedRe.exec(noComments)) !== null) {
          let set = ctx.goPkgImplServices.get(pkgId);
          if (!set) {
            set = new Set();
            ctx.goPkgImplServices.set(pkgId, set);
          }
          set.add(em[1]);
        }
        // どの型が実装しているかまで押さえる。1 パッケージが複数 service を実装すると
        // メソッド名だけでは同定できない(Health のような共通名が衝突する)
        const structRe = /^type\s+(\w+)\s+struct\s*\{([^{}]*)\}/gm;
        let sm: RegExpExecArray | null;
        while ((sm = structRe.exec(noComments)) !== null) {
          const bodyRe = /\bUnimplemented(\w+)Server\b/g;
          for (let bm = bodyRe.exec(sm[2]); bm; bm = bodyRe.exec(sm[2])) {
            const key = `${pkgId}#${sm[1]}`;
            let set = ctx.goImplTypeServices.get(key);
            if (!set) {
              set = new Set();
              ctx.goImplTypeServices.set(key, set);
            }
            set.add(bm[1]);
          }
        }
      }

      const isMainPkg = /^package main\b/m.test(noComments);
      const functions: GoFunc[] = [];
      const funcRe = /^func\s+(?:\(([^)]*)\)\s*)?([A-Za-z_]\w*)/gm;
      let m: RegExpExecArray | null;
      while ((m = funcRe.exec(blanked)) !== null) {
        const recv = m[1] !== undefined ? receiverType(m[1]) : undefined;
        const name = m[2];
        const open = findBodyOpen(blanked, funcRe.lastIndex);
        if (open < 0) continue;
        const close = matchBrace(blanked, open);
        if (close < 0) continue;
        const label = recv ? `${recv}.${name}` : name;
        const funcId = `${pkgId}#${label}`;
        let bodyLines = 0;
        for (let i = open; i <= close; i++) if (blanked[i] === '\n') bodyLines++;
        const declLine = lineOf(m.index);
        const doc = leadingComment(srcLines, declLine);
        ctx.builder.addNode({
          id: funcId,
          label,
          parent: pkgId,
          kind: 'func',
          lang: 'go',
          loc: bodyLines + 1,
          meta: {
            file: wsRel,
            line: declLine,
            ...(doc ? { doc } : {}),
            // プロセス起動点(エントリーポイントカタログ用)
            ...(isMainPkg && !recv && name === 'main' ? { entry: 'main' } : {}),
          },
        });
        functions.push({ id: funcId, name, recv, bodyStart: open, bodyEnd: close });
        if (!recv && !funcIndex.has(name)) funcIndex.set(name, funcId);
        if (recv) {
          // 同名メソッドが複数レシーバに定義されている場合は曖昧(null)にする
          methodIndex.set(name, methodIndex.has(name) ? null : funcId);
        }
      }

      // パッケージレベルのクロージャ `var/const Name = func(...) { ... }`(列 0)。
      // これらは ^func 宣言に含まれないため本体が走査されず呼び出しが欠落していた。
      // 関数内のローカルクロージャは外側関数の本体範囲で既に走査されるため、
      // 二重計上を避けて列 0(パッケージレベル)のみを対象にする。
      const closureRe = /^(?:var|const)\s+([A-Za-z_]\w*)[^=\n]*=\s*func\b/gm;
      let cm: RegExpExecArray | null;
      while ((cm = closureRe.exec(blanked)) !== null) {
        const name = cm[1];
        const open = findBodyOpen(blanked, closureRe.lastIndex);
        if (open < 0) continue;
        const close = matchBrace(blanked, open);
        if (close < 0) continue;
        const funcId = `${pkgId}#${name}`;
        if (functions.some((f) => f.id === funcId)) continue;
        let bodyLines = 0;
        for (let i = open; i <= close; i++) if (blanked[i] === '\n') bodyLines++;
        const declLine = lineOf(cm.index);
        const doc = leadingComment(srcLines, declLine);
        ctx.builder.addNode({
          id: funcId,
          label: name,
          parent: pkgId,
          kind: 'func',
          lang: 'go',
          loc: bodyLines + 1,
          meta: { file: wsRel, line: declLine, ...(doc ? { doc } : {}) },
        });
        functions.push({ id: funcId, name, recv: undefined, bodyStart: open, bodyEnd: close });
        if (!funcIndex.has(name)) funcIndex.set(name, funcId);
      }

      state.files.push({ wsRel, pkgId, aliases, importPaths, functions, blanked });
    }
  }

  // 集めたインターセプタをサービス/モジュール根の meta に付与する。
  // (プロジェクトにモジュールノードがあればそれ、無ければ登録元パッケージの最上位祖先)
  if (interceptors.length > 0) {
    const anchorId = project.nodeId !== '' ? project.nodeId : topAncestorId(ctx, interceptorAnchor);
    const node = ctx.builder.get(anchorId);
    if (node) node.meta = { ...node.meta, interceptors };
  }

  return state;
}

type ImportTarget = { kind: 'pkg' | 'proto'; id: string } | undefined;

/**
 * import パスの解決。厳密一致 → 生成スタブの proto パッケージ名サフィックス →
 * モジュール相対パスのサフィックス一致(同一プロジェクト優先)の順に試す。
 * サフィックス一致は go.mod の module 名と import パスが食い違っているリポジトリへの救済措置。
 */
function resolveImportPath(ctx: Ctx, projectNodeId: string, importPath: string): ImportTarget {
  const pkg = ctx.goPkgOfImportPath.get(importPath);
  if (pkg) return { kind: 'pkg', id: pkg };
  const proto = ctx.protoGoPackage.get(importPath);
  if (proto) return { kind: 'proto', id: proto };
  // ケバブ/スネークの表記ゆれ(customer-service vs customer_service)を吸収して比較
  const normalized = importPath.replace(/-/g, '_');
  for (const [suffix, id] of ctx.protoGoPackageSuffix) {
    const s = suffix.replace(/-/g, '_');
    if (id && (normalized === s || normalized.endsWith('/' + s))) {
      return { kind: 'proto', id };
    }
  }
  // モジュール相対パスのサフィックス一致(最長の rel を優先)
  let bestRel = '';
  let bestEntries: Array<{ pkgId: string; project: string }> = [];
  for (const [rel, entries] of ctx.goPkgRelIndex) {
    if (rel.length <= bestRel.length) continue;
    if (importPath === rel || importPath.endsWith('/' + rel)) {
      bestRel = rel;
      bestEntries = entries;
    }
  }
  if (bestEntries.length > 0) {
    const sameProject = bestEntries.filter((e) => e.project === projectNodeId);
    const pool = sameProject.length > 0 ? sameProject : bestEntries;
    if (pool.length === 1) return { kind: 'pkg', id: pool[0].pkgId };
  }
  return undefined;
}

export function linkGo(ctx: Ctx, state: GoState): void {
  const resolveCache = new Map<string, ImportTarget>();
  const resolve = (importPath: string): ImportTarget => {
    const key = state.project.nodeId + ' ' + importPath;
    if (resolveCache.has(key)) return resolveCache.get(key);
    const target = resolveImportPath(ctx, state.project.nodeId, importPath);
    resolveCache.set(key, target);
    return target;
  };
  const looksInternal = (importPath: string): boolean => {
    for (const prefix of ctx.goModulePrefixes) {
      if (importPath.startsWith(prefix + '/')) return true;
    }
    return false;
  };

  for (const file of state.files) {
    // パッケージレベルの import エッジ + このファイルが参照する proto の集合
    const fileProtoIds = new Set<string>();
    for (const importPath of file.importPaths) {
      const target = resolve(importPath);
      if (!target) {
        // 標準ライブラリ・外部モジュールは対象外。内部っぽいのに解決できないものは警告
        if (looksInternal(importPath)) {
          ctx.builder.warn(`import が解決できません(module 名との不一致?): ${importPath}`);
        }
        continue;
      }
      if (target.kind === 'pkg') {
        if (target.id !== file.pkgId) ctx.builder.addEdge(file.pkgId, target.id, 'import');
      } else {
        ctx.builder.addEdge(file.pkgId, target.id, 'proto');
        fileProtoIds.add(target.id);
      }
    }
    const aliasTargets = new Map<string, NonNullable<ImportTarget>>();
    for (const [alias, importPath] of file.aliases) {
      const target = resolve(importPath);
      if (target) aliasTargets.set(alias, target);
    }

    // このファイルが実装しているサービス(の proto)。実装側での usecase 呼び出し等が
    // RPC 名と同名のとき、クライアント呼び出しと誤認しないよう除外リストにする。
    //
    // 判定は 2 段構え:
    // 1) パッケージ内に Unimplemented<Service>Server の埋め込みがあれば、その service を
    //    実装しているとみなす(protoc-gen-go-grpc の標準形。別ファイルのメソッドも拾える)
    // 2) 埋め込みが見つからないパッケージのみ従来のメソッド名一致にフォールバック。
    //    ただし同名の RPC へフォワードするだけのクライアントラッパー
    //    (func (c *xClient) Foo(...) { return c.stub.Foo(...) } 形式)は実装扱いしない
    const pkgImplServices = ctx.goPkgImplServices.get(file.pkgId);
    const isImplMethod = (fn: GoFunc, service: string): boolean => {
      if (pkgImplServices) return pkgImplServices.has(service);
      // stub/client 系フィールド経由で同名を呼ぶだけならラッパー。
      // (h.repo.GetUser のようにリポジトリへ同名フォワードする正当な実装は除外しない)
      const body = file.blanked.slice(fn.bodyStart, fn.bodyEnd + 1);
      const forwards = new RegExp(
        `\\.\\s*(?:stub|client|cc|conn|grpc\\w*)\\s*\\.\\s*${fn.name}\\s*\\(`,
        'i',
      ).test(body);
      return !forwards;
    };
    const implementedProtos = new Set<string>();
    for (const fn of file.functions) {
      if (!fn.recv) continue;
      const c = (ctx.rpcByName.get(fn.name) ?? []).filter(
        (info) => info.name === fn.name && fileProtoIds.has(info.protoId),
      );
      if (c.length === 1 && isImplMethod(fn, c[0].service)) implementedProtos.add(c[0].protoId);
    }

    const lineOf = makeLineFinder(file.blanked);
    for (const fn of file.functions) {
      const body = file.blanked.slice(fn.bodyStart, fn.bodyEnd + 1);
      // 呼び出し箇所(エッジの site)。ビューアで「どの行から呼んでいるか」に飛べるようにする
      const siteAt = (bodyIndex: number) => ({ f: file.wsRel, l: lineOf(fn.bodyStart + bodyIndex) });

      // 修飾付き呼び出し x.y.Z( — チェーン全体を修飾子、最後の識別子をメンバとして扱う
      const qualifiedRe = /(?<![.\w])([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)\.([A-Za-z_]\w*)\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = qualifiedRe.exec(body)) !== null) {
        const qualifier = m[1];
        const member = m[2];
        // 1) パッケージ別名経由(確度: 高)
        if (!qualifier.includes('.')) {
          const target = aliasTargets.get(qualifier);
          if (target) {
            if (target.kind === 'pkg') {
              // 走査済みパッケージの関数として解決できたときだけ call 辺を張る。
              // 解決できない member は型変換 config.Duration(5) やパッケージ変数の
              // 可能性が高く、パッケージノードへ call を張ると偽陽性になる。
              // パッケージ依存自体は上流の 'import' 辺(pkgId→pkgId)が保持する。
              const funcId = ctx.goFuncsOfPkg.get(target.id)?.get(member);
              if (funcId) ctx.builder.addEdge(fn.id, funcId, 'call', 1, siteAt(m.index));
            } else {
              const rpc = ctx.rpcOfProto.get(target.id)?.get(member);
              if (rpc) ctx.builder.addEdge(fn.id, rpc.rpcId, 'rpc', 1, siteAt(m.index));
              else if (!/^New\w*Client$/.test(member)) ctx.builder.addEdge(fn.id, target.id, 'proto', 1, siteAt(m.index));
            }
            continue;
          }
          if (file.aliases.has(qualifier)) continue; // 標準ライブラリ・外部
        }
        // 2) RPC 名の突き合わせ(確度: 中、スタブ import が条件 §6.2)
        const candidates = (ctx.rpcByName.get(member) ?? []).filter(
          (info) =>
            info.name === member &&
            fileProtoIds.has(info.protoId) &&
            !implementedProtos.has(info.protoId),
        );
        if (candidates.length === 1) {
          ctx.builder.addEdge(fn.id, candidates[0].rpcId, 'rpc', 1, siteAt(m.index));
          continue;
        }
        if (candidates.length > 1) {
          ctx.builder.warn(
            `RPC 名 '${member}' が複数の proto に一致するため接続をスキップ: ${file.wsRel}`,
          );
          continue;
        }
        // 3) 同一パッケージ内 + import 先パッケージで一意なレシーバメソッド(確度: 中)
        //    DI されたインターフェース越しの呼び出し(h.usecase.Execute 等)をこれで繋ぐ
        const methodCandidates = new Set<string>();
        const localMethod = ctx.goMethodsOfPkg.get(file.pkgId)?.get(member);
        if (localMethod) methodCandidates.add(localMethod);
        for (const target of aliasTargets.values()) {
          if (target.kind !== 'pkg') continue;
          const imported = ctx.goMethodsOfPkg.get(target.id)?.get(member);
          if (imported) methodCandidates.add(imported);
        }
        if (methodCandidates.size === 1) {
          const method = [...methodCandidates][0];
          if (method !== fn.id) ctx.builder.addEdge(fn.id, method, 'call', 1, siteAt(m.index));
        }
      }

      // 非修飾呼び出し Y( → 同一パッケージ内の関数
      const bareRe = /(?<![.\w])([A-Za-z_]\w*)\s*\(/g;
      while ((m = bareRe.exec(body)) !== null) {
        const name = m[1];
        if (GO_KEYWORDS.has(name) || GO_BUILTINS.has(name)) continue;
        const target = ctx.goFuncsOfPkg.get(file.pkgId)?.get(name);
        if (target && target !== fn.id) ctx.builder.addEdge(fn.id, target, 'call', 1, siteAt(m.index));
      }

      // RPC 実装(サーバハンドラ)検出: レシーバメソッド名 = RPC 名 + スタブ import
      // クライアントラッパー(同名 RPC へのフォワード)は除外する
      if (fn.recv) {
        const candidates = (ctx.rpcByName.get(fn.name) ?? []).filter(
          (info) => info.name === fn.name && fileProtoIds.has(info.protoId),
        );
        if (candidates.length === 1 && isImplMethod(fn, candidates[0].service)) {
          ctx.builder.addEdge(candidates[0].rpcId, fn.id, 'impl');
        }
      }
    }
  }
}
