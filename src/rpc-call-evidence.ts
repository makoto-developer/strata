// フェーズ A(収集): RPC クライアント呼び出しの「シンボルの証拠」を言語横断で集める。
//
// proto と呼び出し元の間に生成クライアント・Gateway・Federation が何段挟まっても、
// 呼び出し元コードには <Service>Client / <Service>Stub というハンドルと、
// その上で呼ぶ RPC 名が残る。import パスの規約は組織ごとに違って当てにならないので、
// このシンボルだけを証拠として集め、接続は resolve フェーズ(indirection.ts)に任せる。
//
// ここでは「誰が何を呼んでいそうか」しか判定しない。実在する proto と突き合わせるのは
// 解決フェーズなので、多少広めに拾っても嘘の依存にはならない(一致しなければ捨てられる)。

import * as path from 'node:path';
import { stripSource } from './lex.ts';
import { stripPython } from './analyzers/python.ts';
import { parseImports } from './analyzers/golang.ts';
import { stripLineComment } from './analyzers/elixir.ts';
import { readFileText, type Ctx, type Project, type RpcCallEvidence } from './context.ts';

// var 位置に来たら宣言ではないキーワード(`func NewFooClient(` を変数束縛と誤認しないため)
const NOT_A_VAR = new Set([
  'func', 'type', 'var', 'const', 'return', 'range', 'case', 'go', 'defer', 'new', 'if', 'for',
  'else', 'switch', 'select', 'chan', 'map', 'struct', 'interface', 'package', 'import',
]);

/** `x := pb.NewUserServiceClient(conn)` / `x = NewUserServiceStub(ch)` */
const CTOR_BINDING = /\b(\w+)\s*(?::=|=)\s*(?:[\w.]+\.)?New(\w+)(?:Client|Stub)\s*\(/g;
/** `var x pb.UserServiceClient` / 構造体フィールド / 引数の型注釈(修飾子も捕まえる) */
const TYPED_BINDING = /\b(\w+)\s+(?:(\w+)\.)?(\w+)(?:Client|Stub)\b/g;
/** `pb.NewUserServiceClient(conn).GetUser(ctx, req)`(変数に束縛しない直接呼び出し) */
const CTOR_CHAINED = /(?:[\w.]+\.)?New(\w+)(?:Client|Stub)\s*\([^()]*\)\s*\.\s*(\w+)\s*\(/g;
/** Python: `stub = user_pb2_grpc.UserServiceStub(channel)` */
const PY_STUB_BINDING = /\b(\w+)\s*=\s*(?:[\w.]+\.)?(\w+)Stub\s*\(/g;
/** JS/TS: `const c = new UserServiceClient(url)` */
const JS_NEW_CLIENT = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?new\s+(?:[\w.]+\.)?(\w+)Client\s*\(/g;
/** JS/TS(connect-es): `const c = createPromiseClient(UserService, transport)` */
const JS_CREATE_CLIENT = /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?create(?:Promise)?Client\s*\(\s*(?:[\w.]+\.)?(\w+)\s*,/g;
/** Elixir: `User.V1.UserService.Stub.get_user(channel, req)` */
const EX_STUB_CALL = /(?:[\w.]+\.)?(\w+)\.Stub\.(\w+)\s*\(/g;
/** レシーバ付きメソッド呼び出し(`s.userCli.GetUser(` なら receiver=userCli) */
const RECEIVER_CALL = /\b(\w+)\s*\.\s*(\w+)\s*\(/g;

// JS/TS の import / require。Go はブロック形式があるので golang.ts の parseImports に任せる
const JS_IMPORT = /(?:from\s*|import\s*|require\s*\(\s*)["']([^"']+)["']/g;
// Python の import。パスはドット区切りなので / に直してから突き合わせる
const PY_IMPORT = /^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm;

interface Binding {
  service: string; // 例 "UserService"
  fromConstructor: boolean; // 生成クライアントのコンストラクタ由来か(型注釈だけの束縛より強い証拠)
  qualifier?: string; // 型注釈の修飾子(パッケージ別名)
}

/** 1 件の呼び出し。行番号は文字オフセットから後で引く(位置は 1 か所で決める)。 */
interface Hit {
  service: string;
  method: string;
  index: number;
  fromConstructor: boolean;
  qualifier?: string;
}

function lineFinder(src: string): (index: number) => number {
  const offsets: number[] = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') offsets.push(i + 1);
  return (index: number): number => {
    let lo = 0;
    let hi = offsets.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (offsets[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * 変数名 → その変数が掴んでいるクライアントの service 名。
 * スコープを追わない字句処理なので、同じ変数名が複数の service を指すファイルでは
 * どちらの呼び出しか決められない。先勝ちにすると別 service へ誤接続するため、まとめて捨てる。
 */
/** パターン 1 本を走らせて、変数名 -> 束縛候補を積む。 */
function scanBindingPattern(
  code: string,
  spec: { re: RegExp; ctor: boolean; qualified: boolean },
  into: Map<string, Map<string, Binding>>,
): void {
  spec.re.lastIndex = 0;
  for (let m = spec.re.exec(code); m; m = spec.re.exec(code)) {
    const name = m[1];
    const qualifier = spec.qualified ? m[2] : undefined;
    const service = spec.qualified ? m[3] : m[2];
    if (NOT_A_VAR.has(name) || !service || NOT_A_VAR.has(service)) continue;
    const byService = into.get(name) ?? new Map<string, Binding>();
    const prev = byService.get(service);
    byService.set(service, {
      service,
      fromConstructor: (prev?.fromConstructor ?? false) || spec.ctor,
      ...(qualifier ?? prev?.qualifier ? { qualifier: qualifier ?? prev?.qualifier } : {}),
    });
    into.set(name, byService);
  }
}

function collectBindings(
  code: string,
  patterns: Array<{ re: RegExp; ctor: boolean; qualified: boolean }>,
): Map<string, Binding> {
  const seen = new Map<string, Map<string, Binding>>();
  for (const spec of patterns) scanBindingPattern(code, spec, seen);
  const out = new Map<string, Binding>();
  for (const [name, byService] of seen) {
    if (byService.size === 1) out.set(name, [...byService.values()][0]);
  }
  return out;
}

/** バインディング済みの変数に対するメソッド呼び出しを証拠に変換する。 */
function callsOnBindings(code: string, bindings: Map<string, Binding>): Hit[] {
  const out: Hit[] = [];
  RECEIVER_CALL.lastIndex = 0;
  for (let m = RECEIVER_CALL.exec(code); m; m = RECEIVER_CALL.exec(code)) {
    const binding = bindings.get(m[1]);
    if (!binding) continue;
    out.push({
      service: binding.service,
      method: m[2],
      index: m.index,
      fromConstructor: binding.fromConstructor,
      ...(binding.qualifier ? { qualifier: binding.qualifier } : {}),
    });
  }
  return out;
}

/** コンストラクタに直接ぶら下げた呼び出し(変数を経由しない形)。 */
function chainedCalls(code: string): Hit[] {
  const out: Hit[] = [];
  CTOR_CHAINED.lastIndex = 0;
  for (let m = CTOR_CHAINED.exec(code); m; m = CTOR_CHAINED.exec(code)) {
    out.push({ service: m[1], method: m[2], index: m.index, fromConstructor: true });
  }
  return out;
}

/** Go のパッケージ別名 → import パス。型注釈の修飾子から proto を引くのに使う。 */
function goAliasPaths(src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const imp of parseImports(stripSource(src, 'go').noComments)) {
    const segments = imp.path.split('/');
    let last = segments[segments.length - 1];
    if (/^v\d+$/.test(last) && segments.length > 1) last = segments[segments.length - 2];
    out.set(imp.alias ?? last, imp.path);
  }
  return out;
}

/** 呼び出し元ファイルの import パス。候補の絞り込みと経由地の特定にだけ使う。 */
function importPathsOf(src: string, lang: 'go' | 'js' | 'py' | 'ex'): string[] {
  if (lang === 'go') return parseImports(stripSource(src, 'go').noComments).map((i) => i.path);
  const out: string[] = [];
  if (lang === 'js') {
    JS_IMPORT.lastIndex = 0;
    for (let m = JS_IMPORT.exec(src); m; m = JS_IMPORT.exec(src)) out.push(m[1]);
    return out;
  }
  if (lang === 'py') {
    PY_IMPORT.lastIndex = 0;
    for (let m = PY_IMPORT.exec(src); m; m = PY_IMPORT.exec(src)) out.push((m[1] ?? m[2]).replace(/\./g, '/'));
  }
  return out;
}

/** ファイルの呼び出し元ノード。JS はファイル、Go はパッケージ(= ディレクトリ)が単位。 */
function callerNodeOf(ctx: Ctx, project: Project, wsRel: string): string {
  if (ctx.jsFileIds.has(wsRel)) return wsRel;
  const dir = path.posix.dirname(wsRel);
  if (ctx.builder.get(dir)) return dir;
  return project.nodeId;
}

/** Go の関数ノード id(見つからなければ undefined)。線を関数単位まで下ろすために使う。 */
function goFuncAt(ctx: Ctx, pkgId: string, blanked: string, index: number): string | undefined {
  const decl = /^func\s+(?:\([^)]*\)\s*)?(\w+)\s*\(/gm;
  let name: string | undefined;
  for (let m = decl.exec(blanked); m; m = decl.exec(blanked)) {
    if (m.index > index) break;
    name = m[1];
  }
  if (name === undefined) return undefined;
  const funcId = `${pkgId}#${name}`;
  return ctx.builder.get(funcId) ? funcId : undefined;
}

/** snake_case を PascalCase へ(Elixir の RPC 名を proto の表記に寄せる)。 */
function toPascal(name: string): string {
  return name
    .split('_')
    .filter((s) => s !== '')
    .map((s) => s[0].toUpperCase() + s.slice(1))
    .join('');
}

interface FileScan {
  code: string; // 呼び出し検出用(文字列・コメントを潰した後)
  hits: Hit[];
}

function scanGoOrJs(src: string, lang: 'go' | 'js'): FileScan {
  const { blanked } = stripSource(src, lang);
  const patterns =
    lang === 'go'
      ? [
          { re: CTOR_BINDING, ctor: true, qualified: false },
          { re: TYPED_BINDING, ctor: false, qualified: true },
        ]
      : [
          { re: JS_NEW_CLIENT, ctor: true, qualified: false },
          { re: JS_CREATE_CLIENT, ctor: true, qualified: false },
          { re: CTOR_BINDING, ctor: true, qualified: false },
        ];
  const bindings = collectBindings(blanked, patterns);
  return { code: blanked, hits: [...callsOnBindings(blanked, bindings), ...chainedCalls(blanked)] };
}

function scanPython(src: string): FileScan {
  const code = stripPython(src);
  const bindings = collectBindings(code, [{ re: PY_STUB_BINDING, ctor: true, qualified: false }]);
  return { code, hits: [...callsOnBindings(code, bindings), ...chainedCalls(code)] };
}

function scanElixir(src: string): FileScan {
  const code = src.split('\n').map(stripLineComment).join('\n');
  const hits: Hit[] = [];
  EX_STUB_CALL.lastIndex = 0;
  for (let m = EX_STUB_CALL.exec(code); m; m = EX_STUB_CALL.exec(code)) {
    hits.push({ service: m[1], method: toPascal(m[2]), index: m.index, fromConstructor: true });
  }
  return { code, hits };
}

function scanFile(src: string, lang: 'go' | 'js' | 'py' | 'ex'): FileScan {
  if (lang === 'go' || lang === 'js') return scanGoOrJs(src, lang);
  if (lang === 'py') return scanPython(src);
  return scanElixir(src);
}

/** 1 プロジェクト分の呼び出し証拠を ctx.rpcCalls へ積む。 */
function collectProject(ctx: Ctx, project: Project): void {
  const groups: Array<{ files: string[]; lang: 'go' | 'js' | 'py' | 'ex' }> = [
    { files: project.goFiles, lang: 'go' },
    { files: project.jsFiles, lang: 'js' },
    { files: project.pyFiles, lang: 'py' },
    { files: project.exFiles, lang: 'ex' },
  ];
  for (const { files, lang } of groups) {
    for (const wsRel of files) {
      let src: string;
      try {
        src = readFileText(ctx, wsRel);
      } catch {
        continue;
      }
      const scan = scanFile(src, lang);
      if (scan.hits.length === 0) continue;
      const from = callerNodeOf(ctx, project, wsRel);
      if (from === '') continue;
      const lineOf = lineFinder(src);
      const imports = importPathsOf(src, lang);
      const aliasPaths = lang === 'go' ? goAliasPaths(src) : new Map<string, string>();
      for (const hit of scan.hits) {
        const funcId = lang === 'go' ? goFuncAt(ctx, from, scan.code, hit.index) : undefined;
        ctx.rpcCalls.push({
          from,
          ...(funcId ? { funcId } : {}),
          service: hit.service,
          method: hit.method,
          fromConstructor: hit.fromConstructor,
          ...(hit.qualifier && aliasPaths.has(hit.qualifier)
            ? { qualifierPath: aliasPaths.get(hit.qualifier) }
            : {}),
          ...(imports.length > 0 ? { importPaths: imports } : {}),
          file: wsRel,
          line: lineOf(hit.index),
        });
      }
    }
  }
}

/** フェーズ A: 全プロジェクトから RPC 呼び出しのシンボル証拠を集める。 */
export function collectRpcCallEvidence(ctx: Ctx): void {
  for (const project of ctx.projects) collectProject(ctx, project);
}

// テスト用に個別関数も公開
export { collectBindings, callsOnBindings, toPascal };
export type { Binding, Hit };
