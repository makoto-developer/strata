// Python 解析(docs/SPEC.md §6.10)。テキスト・インデントベースの静的解析。
// 関数/メソッド(def)・クラス(class)をノード化し、同一ファイル内で定義された名前への
// 呼び出しを接続する。型推論・クロスモジュール解決はしない(取りこぼし優先)。

import { chainBase, readFileText, type Ctx, type Project } from '../context.ts';

interface PyDef {
  name: string; // 修飾名(Class.method または func)
  short: string; // メソッド短縮名
  line: number; // 1 始まり
  nodeId: string;
  bodyStart: number; // 本体開始行(def の次の行、1 始まり)
  bodyEnd: number; // 本体終了行(含む)
}

interface PyFile {
  id: string;
  defs: PyDef[];
}

export interface PyState {
  project: Project;
  files: PyFile[];
}

const PY_BUILTINS = new Set([
  'print', 'len', 'range', 'int', 'str', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'isinstance', 'issubclass', 'type', 'super', 'open', 'enumerate', 'zip', 'map', 'filter',
  'sorted', 'reversed', 'sum', 'min', 'max', 'abs', 'round', 'repr', 'hash', 'id', 'iter',
  'next', 'getattr', 'setattr', 'hasattr', 'delattr', 'format', 'vars', 'dir', 'input',
  'bytes', 'bytearray', 'frozenset', 'complex', 'object', 'property', 'staticmethod',
  'classmethod', 'callable', 'globals', 'locals', 'exec', 'eval', 'ord', 'chr', 'hex', 'oct', 'bin',
]);
const PY_KEYWORDS = new Set([
  'if', 'elif', 'while', 'for', 'return', 'yield', 'assert', 'with', 'and', 'or', 'not',
  'in', 'is', 'lambda', 'def', 'class', 'try', 'except', 'finally', 'raise', 'import', 'from',
  'as', 'pass', 'break', 'continue', 'global', 'nonlocal', 'del', 'await', 'async', 'else',
]);

/**
 * Python ソースからコメント(#)と文字列(' " ''' """)の中身を空白化する。
 * 改行は保持(行番号のため)。f-string の補間は追跡しない(取りこぼし)。
 */
export function stripPython(src: string): string {
  const n = src.length;
  const out: string[] = new Array(n);
  type S = 'code' | 'hash' | 'sq' | 'dq' | 'sq3' | 'dq3';
  let state: S = 'code';
  const put = (i: number, keep: boolean): void => {
    out[i] = src[i] === '\n' ? '\n' : keep ? src[i] : ' ';
  };
  for (let i = 0; i < n; i++) {
    const c = src[i];
    if (state === 'code') {
      if (c === '#') {
        state = 'hash';
        put(i, false);
      } else if (c === "'" && src[i + 1] === "'" && src[i + 2] === "'") {
        state = 'sq3';
        put(i, false);
        put(++i, false);
        put(++i, false);
      } else if (c === '"' && src[i + 1] === '"' && src[i + 2] === '"') {
        state = 'dq3';
        put(i, false);
        put(++i, false);
        put(++i, false);
      } else if (c === "'") {
        state = 'sq';
        put(i, false);
      } else if (c === '"') {
        state = 'dq';
        put(i, false);
      } else {
        put(i, true);
      }
    } else if (state === 'hash') {
      put(i, false);
      if (c === '\n') state = 'code';
    } else if (state === 'sq' || state === 'dq') {
      if (c === '\\' && i + 1 < n) {
        put(i, false);
        put(++i, false);
      } else {
        put(i, false);
        if ((state === 'sq' && c === "'") || (state === 'dq' && c === '"') || c === '\n') state = 'code';
      }
    } else {
      // sq3 / dq3(複数行文字列)
      const q = state === 'sq3' ? "'" : '"';
      if (c === '\\' && i + 1 < n) {
        put(i, false);
        put(++i, false);
      } else if (c === q && src[i + 1] === q && src[i + 2] === q) {
        put(i, false);
        put(++i, false);
        put(++i, false);
        state = 'code';
      } else {
        put(i, false);
      }
    }
  }
  return out.join('');
}

/** 行の先頭空白の数(タブは 1 として数える。混在は稀なので近似)。 */
function indentOf(line: string): number {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)/;
const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)/;

export function registerPy(ctx: Ctx, project: Project): PyState {
  const state: PyState = { project, files: [] };
  for (const rel of project.pyFiles) {
    let content: string;
    try {
      content = readFileText(ctx, rel);
    } catch {
      continue;
    }
    const blanked = stripPython(content);
    const lines = blanked.split('\n');
    const srcLines = content.split('\n');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const { baseWsRel, baseId } = chainBase(ctx, project, dir);
    const parent = ctx.builder.ensureDirChain(dir, baseWsRel, baseId);
    ctx.builder.addNode({
      id: rel,
      label: rel.slice(rel.lastIndexOf('/') + 1),
      parent: parent === '' ? undefined : parent,
      kind: 'file',
      lang: 'py',
      loc: lines.length,
      meta: { file: rel, line: 1 },
    });

    // クラス文脈をインデントスタックで管理
    const classStack: Array<{ indent: number; name: string }> = [];
    const defs: PyDef[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      const ind = indentOf(line);
      while (classStack.length > 0 && ind <= classStack[classStack.length - 1].indent) classStack.pop();
      const cm = CLASS_RE.exec(line);
      if (cm) {
        classStack.push({ indent: cm[1].length, name: cm[2] });
        continue;
      }
      const dm = DEF_RE.exec(line);
      if (!dm) continue;
      const short = dm[2];
      const cls = classStack.length > 0 && classStack[classStack.length - 1].indent < dm[1].length
        ? classStack[classStack.length - 1].name
        : null;
      const name = cls ? `${cls}.${short}` : short;
      // 本体範囲: def より深いインデントが続く限り
      const defIndent = dm[1].length;
      let end = i;
      for (let j = i + 1; j < lines.length; j++) {
        if (lines[j].trim() === '') continue;
        if (indentOf(lines[j]) > defIndent) end = j;
        else break;
      }
      const nodeId = rel + '#' + name;
      const doc = pyLeadingDoc(srcLines, i + 1);
      ctx.builder.addNode({
        id: nodeId,
        label: name,
        parent: rel,
        kind: 'func',
        lang: 'py',
        meta: { file: rel, line: i + 1, ...(doc ? { doc } : {}) },
      });
      defs.push({ name, short, line: i + 1, nodeId, bodyStart: i + 2, bodyEnd: end + 1 });
    }
    state.files.push({ id: rel, defs });
  }
  return state;
}

/** def の次行(または docstring)の """...""" を説明文として拾う簡易版。 */
function pyLeadingDoc(srcLines: string[], defLine: number): string | undefined {
  // def 行の次の非空行が docstring かどうか
  let i = defLine; // 0 始まりで defLine 行の次
  while (i < srcLines.length && srcLines[i].trim() === '') i++;
  if (i >= srcLines.length) return undefined;
  const t = srcLines[i].trim();
  const m = t.match(/^(?:[rRbBuU]{0,2})("""|''')(.*)/);
  if (!m) return undefined;
  const q = m[1];
  let rest = m[2];
  const endIdx = rest.indexOf(q);
  if (endIdx >= 0) rest = rest.slice(0, endIdx); // 単一行 docstring
  const text = rest.trim();
  if (text === '') return undefined;
  return text.length > 280 ? text.slice(0, 277) + '…' : text;
}

export function linkPy(ctx: Ctx, state: PyState): void {
  for (const file of state.files) {
    let content: string;
    try {
      content = readFileText(ctx, file.id);
    } catch {
      continue;
    }
    const lines = stripPython(content).split('\n');
    // 短縮名 → nodeId(曖昧なら null)
    const byShort = new Map<string, string | null>();
    for (const d of file.defs) {
      byShort.set(d.short, byShort.has(d.short) ? null : d.nodeId);
    }
    // 行 → 所属 def(最も内側)
    const defAt = (lineNo: number): string | null => {
      let best: PyDef | null = null;
      for (const d of file.defs) {
        if (lineNo >= d.bodyStart && lineNo <= d.bodyEnd) {
          if (!best || d.bodyStart > best.bodyStart) best = d;
        }
      }
      return best ? best.nodeId : null;
    };
    const callRe = /(^|[^\w.])([A-Za-z_]\w*)\s*\(|\.([A-Za-z_]\w*)\s*\(/g;
    for (let i = 0; i < lines.length; i++) {
      const fromId = defAt(i + 1);
      if (!fromId) continue;
      callRe.lastIndex = 0;
      for (let m = callRe.exec(lines[i]); m; m = callRe.exec(lines[i])) {
        const name = m[2] ?? m[3];
        if (!name || PY_BUILTINS.has(name) || PY_KEYWORDS.has(name)) continue;
        const target = byShort.get(name);
        if (target && target !== fromId) {
          ctx.builder.addEdge(fromId, target, 'call', 1, { f: file.id, l: i + 1 });
        }
      }
    }
  }
}
