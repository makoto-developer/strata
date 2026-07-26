// TypeScript / JavaScript 解析(docs/SPEC.md §5.3, §6.3)
// ファイル単位の構造 + 関数宣言(トップレベル・クラスメソッド・オブジェクトプロパティ)+ 呼び出し解決。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chainBase, readFileText, type Ctx, type Project } from '../context.ts';
import { countLines, leadingComment, makeLineFinder, matchBrace, stripSource } from '../lex.ts';

interface JsFunc {
  id: string;
  name: string;
  className?: string;
  topLevel: boolean;
  nameIndex: number;
  bodyStart: number;
  bodyEnd: number;
}

interface JsFileInfo {
  wsRel: string;
  named: Map<string, { spec: string; exported: string }>;
  defaults: Map<string, string>;
  namespaces: Map<string, string>;
  specs: string[];
  functions: JsFunc[];
  blanked: string;
}

export interface JsState {
  project: Project;
  files: JsFileInfo[];
  baseUrlRel?: string;
  pathEntries: Array<{ pattern: string; targets: string[] }>;
}

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'typeof', 'void',
  'delete', 'in', 'of', 'do', 'else', 'try', 'finally', 'throw', 'yield',
  'await', 'function', 'class', 'super', 'import', 'export', 'default',
  'extends', 'case', 'instanceof', 'let', 'var', 'const', 'this', 'satisfies', 'as',
]);
const JS_GLOBALS = new Set([
  'require', 'fetch', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'queueMicrotask', 'structuredClone', 'parseInt', 'parseFloat', 'isNaN', 'isFinite',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'btoa', 'atob',
  'String', 'Number', 'Boolean', 'Array', 'Object', 'Promise', 'Error', 'TypeError',
  'RangeError', 'SyntaxError', 'Symbol', 'BigInt', 'RegExp', 'Date', 'Map', 'Set',
  'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'Uint8Array', 'Int8Array', 'Uint16Array',
  'Int16Array', 'Uint32Array', 'Int32Array', 'Float32Array', 'Float64Array',
  'ArrayBuffer', 'DataView', 'TextEncoder', 'TextDecoder', 'URL', 'URLSearchParams',
  'AbortController', 'Headers', 'Request', 'Response', 'FormData', 'Blob', 'File',
  'alert', 'confirm', 'prompt', 'Boolean', 'Function',
]);
// RPC 名ヒューリスティックから除外する、ありふれたメソッド名(誤検出防止)
const COMMON_METHODS = new Set([
  'get', 'set', 'has', 'add', 'delete', 'map', 'filter', 'find', 'push', 'pop',
  'slice', 'splice', 'then', 'catch', 'finally', 'call', 'apply', 'bind', 'on',
  'off', 'emit', 'send', 'end', 'json', 'text', 'log', 'error', 'warn', 'info',
  'run', 'start', 'stop', 'close', 'open', 'read', 'write', 'next', 'list',
]);
const EXTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

function parseJsonc(text: string): Record<string, unknown> | undefined {
  const cleaned = text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/** シグネチャの後ろから本体の '{' を探す。';' に当たったら本体なし。 */
function findBodyOpenJs(blanked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '{' && depth <= 0) return i;
    else if ((ch === ';' || ch === '}') && depth <= 0) return -1;
  }
  return -1;
}

/** アロー関数の式本体の終端(深さ 0 の ';' か行末)を探す。 */
function findExprEnd(blanked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && (ch === ';' || ch === '\n' || ch === ',')) {
      return i;
    }
  }
  return blanked.length - 1;
}

/** 各位置の直前までの '{' ネスト深さを返す。 */
function braceDepths(blanked: string): Int32Array {
  const depths = new Int32Array(blanked.length + 1);
  let depth = 0;
  for (let i = 0; i < blanked.length; i++) {
    depths[i] = depth;
    if (blanked[i] === '{') depth++;
    else if (blanked[i] === '}') depth = Math.max(0, depth - 1);
  }
  depths[blanked.length] = depth;
  return depths;
}

function skipSpaces(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

export function registerJs(ctx: Ctx, project: Project): JsState {
  const state: JsState = { project, files: [], pathEntries: [] };
  if (project.jsFiles.length === 0) {
    if (project.hasJs && project.nodeId !== '') ctx.jsPackageByName.set(project.name, project.nodeId);
    return state;
  }
  if (project.hasJs && project.nodeId !== '') {
    ctx.jsPackageByName.set(project.name, project.nodeId);
  }

  // tsconfig / jsconfig(baseUrl + paths)
  for (const configName of ['tsconfig.json', 'jsconfig.json']) {
    const file = path.join(ctx.rootAbs, project.rootRel, configName);
    if (!fs.existsSync(file)) continue;
    const parsed = parseJsonc(fs.readFileSync(file, 'utf8'));
    const options = (parsed?.compilerOptions ?? {}) as Record<string, unknown>;
    if (typeof options.baseUrl === 'string') {
      state.baseUrlRel = path.posix.normalize(
        path.posix.join(project.rootRel === '' ? '.' : project.rootRel, options.baseUrl),
      ).replace(/^\.\/?/, '');
    }
    if (options.paths && typeof options.paths === 'object') {
      for (const [pattern, targets] of Object.entries(options.paths as Record<string, unknown>)) {
        if (Array.isArray(targets)) {
          state.pathEntries.push({ pattern, targets: targets.filter((t) => typeof t === 'string') });
        }
      }
    }
    break;
  }

  for (const wsRel of project.jsFiles) {
    const src = readFileText(ctx, wsRel);
    const { noComments, blanked } = stripSource(src, 'js');
    const lineOf = makeLineFinder(src);
    const srcLines = src.split('\n');
    const dirname = path.posix.dirname(wsRel);
    const dir = dirname === '.' ? '' : dirname;
    const base = chainBase(ctx, project, dir);
    const parent = ctx.builder.ensureDirChain(dir, base.baseWsRel, base.baseId);
    const ext = path.posix.extname(wsRel);
    // 型・クラス定義(ビューアの ⌘クリック定義ジャンプ用)
    const typeDefs: Record<string, { f: string; l: number }> = {};
    const tdRe = /^\s*(?:export\s+)?(?:declare\s+)?(?:interface|class|enum|type)\s+(\w+)/gm;
    let td: RegExpExecArray | null;
    while ((td = tdRe.exec(noComments)) !== null) {
      if (typeDefs[td[1]] === undefined) typeDefs[td[1]] = { f: wsRel, l: lineOf(td.index) };
    }
    ctx.builder.addNode({
      id: wsRel,
      label: path.posix.basename(wsRel),
      parent,
      kind: 'file',
      lang: ext === '.ts' || ext === '.tsx' ? 'ts' : 'js',
      loc: countLines(src),
      meta: { file: wsRel, line: 1, ...(Object.keys(typeDefs).length > 0 ? { typeDefs } : {}) },
    });
    ctx.jsFileIds.add(wsRel);

    // ---- import の抽出 ----
    const named = new Map<string, { spec: string; exported: string }>();
    const defaults = new Map<string, string>();
    const namespaces = new Map<string, string>();
    const specs: string[] = [];
    let m: RegExpExecArray | null;

    const namedRe = /import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = namedRe.exec(noComments)) !== null) {
      specs.push(m[2]);
      for (const rawItem of m[1].split(',')) {
        const item = rawItem.trim().replace(/^type\s+/, '');
        if (item === '') continue;
        const asMatch = item.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
        if (asMatch) named.set(asMatch[2] ?? asMatch[1], { spec: m[2], exported: asMatch[1] });
      }
    }
    const nsRe = /import\s*\*\s*as\s+([\w$]+)\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = nsRe.exec(noComments)) !== null) {
      specs.push(m[2]);
      namespaces.set(m[1], m[2]);
    }
    const defaultRe = /import\s+(?:type\s+)?([\w$]+)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = defaultRe.exec(noComments)) !== null) {
      specs.push(m[3]);
      defaults.set(m[1], m[3]);
      if (m[2]) {
        for (const rawItem of m[2].split(',')) {
          const item = rawItem.trim().replace(/^type\s+/, '');
          const asMatch = item.match(/^([\w$]+)(?:\s+as\s+([\w$]+))?$/);
          if (asMatch) named.set(asMatch[2] ?? asMatch[1], { spec: m[3], exported: asMatch[1] });
        }
      }
    }
    const sideEffectRe = /import\s*['"]([^'"]+)['"]/g;
    while ((m = sideEffectRe.exec(noComments)) !== null) specs.push(m[1]);
    const reexportRe = /export\s*(?:\{[^}]*\}|\*(?:\s*as\s+[\w$]+)?)\s*from\s*['"]([^'"]+)['"]/g;
    while ((m = reexportRe.exec(noComments)) !== null) specs.push(m[1]);
    const requireRe = /(?:const|let|var)\s+(?:([\w$]+)|\{[^}]*\})\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = requireRe.exec(noComments)) !== null) {
      specs.push(m[2]);
      if (m[1]) namespaces.set(m[1], m[2]);
    }
    const dynImportRe = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((m = dynImportRe.exec(noComments)) !== null) specs.push(m[1]);

    // ---- 関数の抽出 ----
    const depths = braceDepths(blanked);
    const functions: JsFunc[] = [];
    const claimed = new Set<number>();
    const usedIds = new Set<string>();

    const makeId = (label: string): string => {
      let id = `${wsRel}#${label}`;
      let n = 2;
      while (usedIds.has(id)) id = `${wsRel}#${label}~${n++}`;
      usedIds.add(id);
      return id;
    };
    const pushFunc = (
      name: string,
      label: string,
      nameIndex: number,
      bodyStart: number,
      bodyEnd: number,
      topLevel: boolean,
      className?: string,
    ): void => {
      if (bodyStart < 0 || bodyEnd < 0 || claimed.has(bodyStart)) return;
      claimed.add(bodyStart);
      const id = makeId(label);
      let lines = 0;
      for (let i = bodyStart; i <= bodyEnd; i++) if (blanked[i] === '\n') lines++;
      const declLine = lineOf(nameIndex);
      const doc = leadingComment(srcLines, declLine);
      ctx.builder.addNode({
        id,
        label,
        parent: wsRel,
        kind: 'func',
        lang: ext === '.ts' || ext === '.tsx' ? 'ts' : 'js',
        loc: lines + 1,
        meta: { file: wsRel, line: declLine, ...(doc ? { doc } : {}) },
      });
      functions.push({ id, name, className, topLevel, nameIndex, bodyStart, bodyEnd });
    };

    // 1) function 宣言(トップレベル)
    const fnDeclRe = /(?:^|[\s;})])((?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*)([\w$]+)?\s*[(<]/g;
    while ((m = fnDeclRe.exec(blanked)) !== null) {
      const keywordIndex = m.index + (m[0].length - m[1].length - (m[2]?.length ?? 0) - 1);
      const declStart = m.index + m[0].indexOf('function');
      if (depths[declStart] !== 0) continue;
      const name = m[2] ?? 'default';
      const open = findBodyOpenJs(blanked, fnDeclRe.lastIndex - 1);
      if (open < 0) continue;
      const close = matchBrace(blanked, open);
      pushFunc(name, name, m[2] ? declStart + m[1].length : declStart, open, close, true);
      void keywordIndex;
    }

    // 2) const 変数への関数代入(トップレベル)
    const constFnRe = /(?:^|[\s;])(?:export\s+)?const\s+([\w$]+)[^=;\n]*=\s*(?:async\s+)?function\b/g;
    while ((m = constFnRe.exec(blanked)) !== null) {
      const nameIndex = m.index + m[0].indexOf(m[1]);
      if (depths[nameIndex] !== 0) continue;
      const open = findBodyOpenJs(blanked, constFnRe.lastIndex);
      if (open < 0) continue;
      pushFunc(m[1], m[1], nameIndex, open, matchBrace(blanked, open), true);
    }
    const arrowRe = /(?:^|[\s;])(?:export\s+)?const\s+([\w$]+)[^=;\n]*=\s*(?:async\s*)?(\([^()]*(?:\([^()]*\)[^()]*)*\)|[\w$]+)\s*(?::[^={};\n]+)?=>/g;
    while ((m = arrowRe.exec(blanked)) !== null) {
      const nameIndex = m.index + m[0].indexOf(m[1]);
      if (depths[nameIndex] !== 0) continue;
      const afterArrow = skipSpaces(blanked, arrowRe.lastIndex);
      if (blanked[afterArrow] === '{') {
        pushFunc(m[1], m[1], nameIndex, afterArrow, matchBrace(blanked, afterArrow), true);
      } else {
        pushFunc(m[1], m[1], nameIndex, afterArrow, findExprEnd(blanked, afterArrow), true);
      }
    }

    // 3) クラスメソッド
    const classRe = /(?:^|[\s;])(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/g;
    while ((m = classRe.exec(blanked)) !== null) {
      const classNameIndex = m.index + m[0].indexOf(m[1]);
      if (depths[classNameIndex] !== 0) continue;
      const className = m[1];
      let bodyOpen = blanked.indexOf('{', classRe.lastIndex);
      if (bodyOpen < 0) continue;
      const bodyClose = matchBrace(blanked, bodyOpen);
      if (bodyClose < 0) continue;
      const classDepth = depths[bodyOpen] + 1;
      const body = blanked.slice(bodyOpen, bodyClose);
      const methodRe = /(?:^|[\n;{}])\s*((?:public\s+|private\s+|protected\s+|static\s+|readonly\s+|override\s+|async\s+)*)(?:get\s+|set\s+)?\*?\s*([\w$]+)\s*(?:<[^>\n]*>)?\s*\(/g;
      let mm: RegExpExecArray | null;
      while ((mm = methodRe.exec(body)) !== null) {
        const name = mm[2];
        if (JS_KEYWORDS.has(name)) continue;
        const absNameIndex = bodyOpen + mm.index + mm[0].lastIndexOf(name);
        if (depths[absNameIndex] !== classDepth) continue;
        const open = findBodyOpenJs(blanked, bodyOpen + methodRe.lastIndex - 1);
        if (open < 0 || open > bodyClose) continue;
        pushFunc(name, `${className}.${name}`, absNameIndex, open, matchBrace(blanked, open), false, className);
      }
      const propArrowRe = /(?:^|[\n;{}])\s*(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*([\w$]+)\s*=\s*(?:async\s*)?\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::[^={};\n]+)?=>/g;
      while ((mm = propArrowRe.exec(body)) !== null) {
        const name = mm[1];
        if (JS_KEYWORDS.has(name)) continue;
        const absNameIndex = bodyOpen + mm.index + mm[0].indexOf(name);
        if (depths[absNameIndex] !== classDepth) continue;
        const afterArrow = skipSpaces(blanked, bodyOpen + propArrowRe.lastIndex);
        if (blanked[afterArrow] === '{') {
          pushFunc(name, `${className}.${name}`, absNameIndex, afterArrow, matchBrace(blanked, afterArrow), false, className);
        } else {
          pushFunc(name, `${className}.${name}`, absNameIndex, afterArrow, findExprEnd(blanked, afterArrow), false, className);
        }
      }
    }

    // 4) オブジェクトプロパティの関数(GraphQL resolver 等。深さ問わず)
    const propFnRe = /(?<![\w$])([\w$]+)\s*:\s*(?:async\s*)?function\b/g;
    while ((m = propFnRe.exec(blanked)) !== null) {
      const open = findBodyOpenJs(blanked, propFnRe.lastIndex);
      if (open < 0) continue;
      pushFunc(m[1], m[1], m.index, open, matchBrace(blanked, open), false);
    }
    const propArrowRe = /(?<![\w$])([\w$]+)\s*:\s*(?:async\s*)?\([^()]*(?:\([^()]*\)[^()]*)*\)\s*(?::[^={};\n]*)?=>/g;
    while ((m = propArrowRe.exec(blanked)) !== null) {
      const afterArrow = skipSpaces(blanked, propArrowRe.lastIndex);
      if (blanked[afterArrow] === '{') {
        pushFunc(m[1], m[1], m.index, afterArrow, matchBrace(blanked, afterArrow), false);
      } else {
        pushFunc(m[1], m[1], m.index, afterArrow, findExprEnd(blanked, afterArrow), false);
      }
    }

    // エクスポート索引(トップレベル関数のみ)
    const exportsMap = new Map<string, string>();
    for (const fn of functions) {
      if (fn.topLevel && !exportsMap.has(fn.name)) exportsMap.set(fn.name, fn.id);
    }
    ctx.jsExports.set(wsRel, exportsMap);

    state.files.push({ wsRel, named, defaults, namespaces, specs, functions, blanked });
  }
  return state;
}

// ---- 接続フェーズ ----

type Resolved =
  | { type: 'file'; id: string }
  | { type: 'package'; id: string }
  | { type: 'proto'; id: string }
  | undefined;

function tryFile(ctx: Ctx, rel: string): string | undefined {
  const p = path.posix.normalize(rel).replace(/^\.\//, '');
  const candidates: string[] = [p];
  for (const ext of EXTS) candidates.push(p + ext);
  const stripped = p.replace(/\.(m?js|cjs|jsx)$/, '');
  if (stripped !== p) {
    candidates.push(stripped + '.ts', stripped + '.tsx', stripped + '.js', stripped + '.jsx');
  }
  for (const ext of EXTS) candidates.push(p + '/index' + ext);
  for (const c of candidates) {
    if (ctx.jsFileIds.has(c)) return c;
  }
  return undefined;
}

function protoHeuristic(ctx: Ctx, fileId: string, spec: string): string | undefined {
  const baseName = path.posix.basename(spec).replace(/\.(m?[jt]sx?)$/, '');
  const m = baseName.match(/^(.*?)(?:[._-](?:pb2?|grpc(?:_web)?|connect(?:web)?|pb_service))+$/);
  if (!m || m[1] === '') return undefined;
  const candidates = ctx.protoByBase.get(m[1]);
  if (!candidates || candidates.length === 0) return undefined;
  if (candidates.length > 1) {
    ctx.builder.warn(`生成スタブ '${spec}' に一致する proto が複数あるため接続をスキップ: ${fileId}`);
    return undefined;
  }
  return candidates[0];
}

function resolveSpec(ctx: Ctx, state: JsState, fileDir: string, fileId: string, spec: string): Resolved {
  if (spec.startsWith('.')) {
    const resolved = tryFile(ctx, path.posix.join(fileDir, spec));
    if (resolved) return { type: 'file', id: resolved };
    const proto = protoHeuristic(ctx, fileId, spec);
    if (proto) return { type: 'proto', id: proto };
    return undefined;
  }
  // tsconfig paths
  for (const entry of state.pathEntries) {
    const starIndex = entry.pattern.indexOf('*');
    let starValue: string | undefined;
    if (starIndex < 0) {
      if (spec !== entry.pattern) continue;
      starValue = '';
    } else {
      const prefix = entry.pattern.slice(0, starIndex);
      const suffix = entry.pattern.slice(starIndex + 1);
      if (!spec.startsWith(prefix) || !spec.endsWith(suffix)) continue;
      starValue = spec.slice(prefix.length, spec.length - suffix.length);
    }
    for (const target of entry.targets) {
      // starValue は解析対象のパス由来なので、$& などが展開されないよう関数形式で置換する
      const targetPath = target.replace('*', () => starValue);
      const baseDir = state.baseUrlRel ?? (state.project.rootRel === '' ? '' : state.project.rootRel);
      const resolved = tryFile(ctx, path.posix.join(baseDir === '' ? '.' : baseDir, targetPath));
      if (resolved) return { type: 'file', id: resolved };
    }
  }
  // ワークスペース内の他パッケージ(ベア指定子)
  let bestName: string | undefined;
  for (const name of ctx.jsPackageByName.keys()) {
    if (spec === name || spec.startsWith(name + '/')) {
      if (!bestName || name.length > bestName.length) bestName = name;
    }
  }
  if (bestName) {
    const pkgNodeId = ctx.jsPackageByName.get(bestName)!;
    if (spec.length > bestName.length) {
      const sub = spec.slice(bestName.length + 1);
      const otherRoot = pkgNodeId === '.' ? '' : pkgNodeId;
      const resolved = tryFile(ctx, otherRoot === '' ? sub : otherRoot + '/' + sub);
      if (resolved) return { type: 'file', id: resolved };
    }
    return { type: 'package', id: pkgNodeId };
  }
  const proto = protoHeuristic(ctx, fileId, spec);
  if (proto) return { type: 'proto', id: proto };
  return undefined; // npm 外部依存など
}

function addProtoRef(ctx: Ctx, state: JsState, fileId: string, protoId: string): void {
  let fileRefs = ctx.jsProtoRefsOfFile.get(fileId);
  if (!fileRefs) {
    fileRefs = new Set();
    ctx.jsProtoRefsOfFile.set(fileId, fileRefs);
  }
  fileRefs.add(protoId);
  const projectKey = state.project.nodeId;
  let projectRefs = ctx.jsProtoRefsOfProject.get(projectKey);
  if (!projectRefs) {
    projectRefs = new Set();
    ctx.jsProtoRefsOfProject.set(projectKey, projectRefs);
  }
  projectRefs.add(protoId);
}

export function linkJs(ctx: Ctx, state: JsState): void {
  // フェーズ A: import エッジ(proto 参照の索引もここで完成させる)
  for (const file of state.files) {
    const fileDir = path.posix.dirname(file.wsRel) === '.' ? '' : path.posix.dirname(file.wsRel);
    for (const spec of file.specs) {
      const resolved = resolveSpec(ctx, state, fileDir, file.wsRel, spec);
      if (!resolved) continue;
      if (resolved.type === 'proto') {
        ctx.builder.addEdge(file.wsRel, resolved.id, 'proto');
        addProtoRef(ctx, state, file.wsRel, resolved.id);
      } else {
        if (resolved.id !== file.wsRel) ctx.builder.addEdge(file.wsRel, resolved.id, 'import');
      }
    }
  }

  // フェーズ B: 呼び出しエッジ
  for (const file of state.files) {
    const fileDir = path.posix.dirname(file.wsRel) === '.' ? '' : path.posix.dirname(file.wsRel);
    const localFuncs = new Map<string, string>();
    for (const fn of file.functions) {
      if (!localFuncs.has(fn.name)) localFuncs.set(fn.name, fn.id);
    }
    const declIndexes = new Set(file.functions.map((f) => f.nameIndex));
    const sorted = [...file.functions].sort((a, b) => a.bodyStart - b.bodyStart);
    // 呼び出し位置 index を含む「最も内側の関数」を返す。関数はネストするが兄弟は重ならないため、
    // bodyStart <= index の中で index を含む最大 bodyStart のものが innermost。
    // 二分探索で開始位置を絞り、そこから後方に少し歩くだけで求まる(呼び出しは通常関数内=ほぼ O(1))。
    // 従来は呼び出しごとに全関数を線形走査していた(巨大ファイルで O(呼び出し数 × 関数数))。
    const callerFnAt = (index: number): JsFunc | undefined => {
      let lo = 0;
      let hi = sorted.length - 1;
      let start = -1; // bodyStart <= index を満たす最大インデックス
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (sorted[mid].bodyStart <= index) {
          start = mid;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      for (let k = start; k >= 0; k--) {
        if (index <= sorted[k].bodyEnd) return sorted[k]; // index を含む最初(=最内側)の関数
      }
      return undefined; // どの関数にも含まれない = モジュールトップレベル
    };
    const callerAt = (index: number): string => callerFnAt(index)?.id ?? file.wsRel; // 関数外はファイルノードに帰属
    const resolveModuleTarget = (spec: string, exported: string): string | undefined => {
      const resolved = resolveSpec(ctx, state, fileDir, file.wsRel, spec);
      if (!resolved) return undefined;
      if (resolved.type === 'file') {
        return ctx.jsExports.get(resolved.id)?.get(exported) ?? resolved.id;
      }
      return resolved.id;
    };

    const lineOfLink = makeLineFinder(file.blanked);
    const siteAt = (index: number) => ({ f: file.wsRel, l: lineOfLink(index) });

    let m: RegExpExecArray | null;
    // 修飾付き呼び出し x.y.m( — チェーン全体を修飾子、最後の識別子をメンバとして扱う
    const qualifiedRe = /(?<![\w$.])([\w$]+(?:\s*\.\s*[\w$]+)*)\s*\.\s*([\w$]+)\s*\(/g;
    while ((m = qualifiedRe.exec(file.blanked)) !== null) {
      const qualifier = m[1];
      const member = m[2];
      const caller = callerAt(m.index);
      const firstSeg = qualifier.split('.')[0].trim();
      if (!qualifier.includes('.')) {
        const nsSpec = file.namespaces.get(qualifier);
        if (nsSpec) {
          const target = resolveModuleTarget(nsSpec, member);
          if (target && target !== caller) ctx.builder.addEdge(caller, target, 'call', 1, siteAt(m.index));
          continue;
        }
      }
      // this.method( → 同一ファイル内のクラスメソッド(同一クラス優先)
      if (firstSeg === 'this') {
        const callerFn = callerFnAt(m.index);
        let methods = file.functions.filter((f) => f.name === member && f.className !== undefined);
        if (callerFn?.className) {
          const sameClass = methods.filter((f) => f.className === callerFn.className);
          if (sameClass.length > 0) methods = sameClass;
        }
        if (methods.length === 1) {
          if (methods[0].id !== caller) ctx.builder.addEdge(caller, methods[0].id, 'call', 1, siteAt(m.index));
          continue;
        }
      }
      // RPC 名ヒューリスティック(§6.3)
      if (COMMON_METHODS.has(member)) continue;
      const infos = ctx.rpcByName.get(member);
      if (!infos || infos.length === 0) continue;
      const fileRefs = ctx.jsProtoRefsOfFile.get(file.wsRel);
      const projectRefs = ctx.jsProtoRefsOfProject.get(state.project.nodeId);
      let candidates = infos.filter((info) => fileRefs?.has(info.protoId));
      if (candidates.length === 0) candidates = infos.filter((info) => projectRefs?.has(info.protoId));
      if (candidates.length === 1) {
        ctx.builder.addEdge(caller, candidates[0].rpcId, 'rpc', 1, siteAt(m.index));
      } else if (candidates.length > 1) {
        ctx.builder.warn(`RPC 名 '${member}' が複数の proto に一致するため接続をスキップ: ${file.wsRel}`);
      }
    }

    // 非修飾呼び出し f(
    const bareRe = /(?<![.\w$])([\w$]+)\s*\(/g;
    while ((m = bareRe.exec(file.blanked)) !== null) {
      const name = m[1];
      if (JS_KEYWORDS.has(name) || JS_GLOBALS.has(name)) continue;
      if (declIndexes.has(m.index)) continue; // 宣言自身
      const caller = callerAt(m.index);
      const local = localFuncs.get(name);
      if (local) {
        if (local !== caller) ctx.builder.addEdge(caller, local, 'call', 1, siteAt(m.index));
        continue;
      }
      const namedBinding = file.named.get(name);
      if (namedBinding) {
        const target = resolveModuleTarget(namedBinding.spec, namedBinding.exported);
        if (target && target !== caller) ctx.builder.addEdge(caller, target, 'call', 1, siteAt(m.index));
        continue;
      }
      const defaultSpec = file.defaults.get(name);
      if (defaultSpec) {
        const target = resolveModuleTarget(defaultSpec, 'default');
        if (target && target !== caller) ctx.builder.addEdge(caller, target, 'call', 1, siteAt(m.index));
      }
    }

    // RPC 実装(サーバハンドラ)検出: Service/Server 系クラスのメソッド名 = RPC 名
    for (const fn of file.functions) {
      if (!fn.className || !/Service|Server|Impl|Handler|Controller/.test(fn.className)) continue;
      const infos = ctx.rpcByName.get(fn.name);
      if (!infos) continue;
      const fileRefs = ctx.jsProtoRefsOfFile.get(file.wsRel);
      const projectRefs = ctx.jsProtoRefsOfProject.get(state.project.nodeId);
      let candidates = infos.filter((info) => fileRefs?.has(info.protoId));
      if (candidates.length === 0) candidates = infos.filter((info) => projectRefs?.has(info.protoId));
      if (candidates.length === 1) {
        ctx.builder.addEdge(candidates[0].rpcId, fn.id, 'impl');
      }
    }
  }
}
