// Elixir 解析(docs/SPEC.md §6.7)。
// 目的は Phoenix 等の Elixir フロントエンド/サービスからの gRPC 呼び出し検出。
// elixir-grpc の規約(`<Package>.<Service>.Stub.<snake_case_rpc>(channel, req)`)を
// alias 解決 + snake→Pascal 変換で RPC 名索引に突き合わせる。
// 型推論はしない。ローカル関数呼び出しは「同一ファイル内で定義された名前」のみ接続する。

import { chainBase, readFileText, type Ctx, type Project } from '../context.ts';

interface ExDef {
  name: string;
  line: number; // 1-origin
  nodeId: string;
}

interface ExFile {
  id: string; // ws 相対パス = ノード id
  defs: ExDef[]; // 行番号昇順
}

export interface ExState {
  project: Project;
  files: ExFile[];
}

const DEF_RE = /^\s*defp?\s+([a-z_][A-Za-z0-9_?!]*)/;
// `Mod.Sub.func(` 形式(モジュール修飾付きの関数呼び出し)
const MOD_CALL_RE = /([A-Z][\w.]*)\.([a-z_][a-z0-9_?!]*)\(/g;
// `func(` 形式(修飾なし)。ドット・@・: の直後は除外(Mod.f / @attr( / :erlang.f)
const LOCAL_CALL_RE = /(^|[^\w.:@])([a-z_][a-z0-9_?!]*)\(/g;
// 括弧なしのパイプ呼び出し `x |> func` / `x |> Mod.func`。括弧付き(`|> func(...)`)は
// 上の *_CALL_RE が拾うので、直後が `(` のものは除外して二重計上を避ける。
const PIPE_LOCAL_RE = /\|>\s*([a-z_][a-z0-9_?!]*)(?!\s*[.(])/g;
const PIPE_MOD_RE = /\|>\s*([A-Z][\w.]*)\.([a-z_][a-z0-9_?!]*)(?!\s*\()/g;
// キャプチャ `&func/arity` / `&Mod.func/arity`
const CAPTURE_LOCAL_RE = /&([a-z_][a-z0-9_?!]*)\/\d/g;
const CAPTURE_MOD_RE = /&([A-Z][\w.]*)\.([a-z_][a-z0-9_?!]*)\/\d/g;

function snakeToPascal(s: string): string {
  return s
    .split('_')
    .filter((p) => p !== '')
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join('');
}

/**
 * RPC 名の索引引き。snake→Pascal の機械変換は頭字語を潰す
 * (confirm_cod_payment → ConfirmCodPayment ≠ ConfirmCODPayment)ため、
 * 厳密一致で見つからなければ小文字化した索引で救済する。
 */
function lookupRpc(ctx: Ctx, rpcName: string) {
  const exact = ctx.rpcByName.get(rpcName);
  if (exact && exact.length > 0) return exact;
  return ctx.rpcByNameLower.get(rpcName.toLowerCase()) ?? [];
}

/**
 * def の直上の説明文を抽出する。連続する `# ...` コメント、
 * または `@doc "..."` (単一行)に対応。@spec / @impl 行は読み飛ばす。
 */
function exLeadingDoc(lines: string[], defIndex: number): string | undefined {
  let i = defIndex - 1;
  // @spec / @impl / デコレータ的な行はスキップして、その上を見る
  while (i >= 0 && /^\s*@(spec|impl|tag)\b/.test(lines[i])) i--;
  const docMatch = i >= 0 ? lines[i].match(/^\s*@doc\s+"([^"]+)"\s*$/) : null;
  if (docMatch) return docMatch[1];
  const out: string[] = [];
  for (; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('#')) break;
    out.push(t.replace(/^#+\s?/, ''));
  }
  if (out.length === 0) return undefined;
  out.reverse();
  const text = out.join(' ').trim();
  if (text === '') return undefined;
  return text.length > 280 ? text.slice(0, 277) + '…' : text;
}

/**
 * コメント(# 〜 行末)を除去する。ただし文字列補間 `#{...}`、二重引用符文字列内の
 * `#`、文字リテラル `?#` は誤ってコメント開始と見なさない(補間内の呼び出しは残す)。
 * 行をまたぐ補間や sigil までは追わない(検出目的では許容)。
 */
function stripLineComment(line: string): string {
  let inStr = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '?' && i + 1 < line.length) {
      i++; // 文字リテラル(?# など)。次の 1 文字を読み飛ばす
      continue;
    }
    if (c === '#') {
      if (line[i + 1] === '{') {
        // 文字列補間 #{...}: 対応する } まで読み飛ばして残す
        i += 2;
        let depth = 1;
        for (; i < line.length && depth > 0; i++) {
          if (line[i] === '{') depth++;
          else if (line[i] === '}') depth--;
        }
        i--;
        continue;
      }
      return line.slice(0, i); // 真のコメント
    }
  }
  return line;
}

/**
 * alias 表(束縛名 → フルモジュールパス)を収集する。
 * `alias A.B.{\n  C.D,\n  E\n}` のように複数行に渡る形式があるため、
 * コメント除去済みの全文に対して正規表現で処理する。
 */
export function collectExAliases(src: string): Map<string, string> {
  const aliases = new Map<string, string>();
  let rest = src.replace(/\balias\s+([A-Z][\w.]*)\s*\.\s*\{([^}]*)\}/g, (_all, base: string, items: string) => {
    for (const item of items.split(',')) {
      const t = item.trim();
      if (t === '') continue;
      const full = base + '.' + t;
      const segs = full.split('.');
      aliases.set(segs[segs.length - 1], full);
    }
    return '';
  });
  rest = rest.replace(/\balias\s+([A-Z][\w.]*)\s*,\s*as:\s*([A-Z]\w*)/g, (_all, base: string, as: string) => {
    aliases.set(as, base);
    return '';
  });
  rest.replace(/\balias\s+([A-Z][\w.]*)/g, (_all, base: string) => {
    const segs = base.split('.');
    aliases.set(segs[segs.length - 1], base);
    return '';
  });
  return aliases;
}

export function resolveExModule(aliases: Map<string, string>, prefix: string): string {
  const segs = prefix.split('.');
  const mapped = aliases.get(segs[0]);
  return mapped ? [mapped, ...segs.slice(1)].join('.') : prefix;
}

/** テストファイル等、行帰属が不要な用途向け: content 中の Stub 呼び出しに一致する RPC id 一覧。 */
export function exStubRpcIds(ctx: Ctx, content: string): string[] {
  const src = content.split('\n').map(stripLineComment).join('\n');
  const aliases = collectExAliases(src);
  const out = new Set<string>();
  MOD_CALL_RE.lastIndex = 0;
  for (let m = MOD_CALL_RE.exec(src); m; m = MOD_CALL_RE.exec(src)) {
    const full = resolveExModule(aliases, m[1]);
    const segs = full.split('.');
    if (segs[segs.length - 1] !== 'Stub' || segs.length < 2) continue;
    const service = segs[segs.length - 2];
    const rpcName = snakeToPascal(m[2]);
    const candidates = lookupRpc(ctx, rpcName).filter((r) => r.service === service);
    if (candidates.length === 1) out.add(candidates[0].rpcId);
  }
  return [...out].sort();
}

export function registerEx(ctx: Ctx, project: Project): ExState {
  const state: ExState = { project, files: [] };
  for (const rel of project.exFiles) {
    let content: string;
    try {
      content = readFileText(ctx, rel);
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    const { baseWsRel, baseId } = chainBase(ctx, project, dir);
    const parent = ctx.builder.ensureDirChain(dir, baseWsRel, baseId);
    // エントリーポイントカタログ用: LiveView(画面)と handle_event(ユーザー操作イベント)
    const isView =
      /use\s+[\w.]+,\s*:live_view\b|use\s+Phoenix\.LiveView\b/.test(content) && !/\bdefmacro\s/.test(content);
    const events: string[] = [];
    for (const em of content.matchAll(/def\s+handle_event\(\s*"([^"]+)"/g)) {
      if (!events.includes(em[1])) events.push(em[1]);
    }
    ctx.builder.addNode({
      id: rel,
      label: rel.slice(rel.lastIndexOf('/') + 1),
      parent: parent === '' ? undefined : parent,
      kind: 'file',
      lang: 'ex',
      loc: lines.length,
      meta: {
        file: rel,
        line: 1,
        ...(isView ? { entry: 'view' } : {}),
        ...(events.length > 0 ? { events } : {}),
      },
    });
    const defs: ExDef[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < lines.length; i++) {
      const m = DEF_RE.exec(lines[i]);
      if (!m) continue;
      const name = m[1];
      if (seen.has(name)) continue; // 複数クローズ(パターンマッチ)は最初の定義に集約
      seen.add(name);
      const nodeId = rel + '#' + name;
      const doc = exLeadingDoc(lines, i);
      ctx.builder.addNode({
        id: nodeId,
        label: name,
        parent: rel,
        kind: 'func',
        lang: 'ex',
        meta: { file: rel, line: i + 1, ...(doc ? { doc } : {}) },
      });
      defs.push({ name, line: i + 1, nodeId });
    }
    state.files.push({ id: rel, defs });
  }
  return state;
}

export function linkEx(ctx: Ctx, state: ExState): void {
  for (const file of state.files) {
    let content: string;
    try {
      content = readFileText(ctx, file.id);
    } catch {
      continue;
    }
    const lines = content.split('\n');
    const defByName = new Map(file.defs.map((d) => [d.name, d.nodeId]));

    const aliases = collectExAliases(lines.map(stripLineComment).join('\n'));
    const resolveModule = (prefix: string): string => resolveExModule(aliases, prefix);

    // 呼び出し検出(行単位で走査し、直近の def を呼び出し元とする)
    let defIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      while (defIdx + 1 < file.defs.length && file.defs[defIdx + 1].line <= i + 1) defIdx++;
      const fromId = defIdx >= 0 ? file.defs[defIdx].nodeId : file.id;
      const line = stripLineComment(lines[i]);

      // 同一ファイル内で定義されたローカル関数への呼び出し
      const addLocal = (name: string): void => {
        const target = defByName.get(name);
        if (target && target !== fromId) ctx.builder.addEdge(fromId, target, 'call', 1, { f: file.id, l: i + 1 });
      };
      // elixir-grpc の Stub 呼び出しだけを RPC として扱う
      const addMod = (prefix: string, fn: string): void => {
        const segs = resolveModule(prefix).split('.');
        if (segs[segs.length - 1] !== 'Stub' || segs.length < 2) return;
        const service = segs[segs.length - 2];
        const rpcName = snakeToPascal(fn);
        const candidates = lookupRpc(ctx, rpcName).filter((r) => r.service === service);
        if (candidates.length === 1) {
          ctx.builder.addEdge(fromId, candidates[0].rpcId, 'rpc', 1, { f: file.id, l: i + 1 });
        } else if (candidates.length > 1) {
          ctx.builder.warn(
            `Elixir: RPC '${service}.${rpcName}' が複数の proto に一致するため接続をスキップ: ${file.id}`,
          );
        }
      };

      const runMod = (re: RegExp): void => {
        re.lastIndex = 0;
        for (let m = re.exec(line); m; m = re.exec(line)) addMod(m[1], m[2]);
      };
      const runLocal = (re: RegExp): void => {
        re.lastIndex = 0;
        for (let m = re.exec(line); m; m = re.exec(line)) addLocal(m[1]);
      };

      runMod(MOD_CALL_RE); // Mod.func(...)
      runMod(PIPE_MOD_RE); // |> Mod.func
      runMod(CAPTURE_MOD_RE); // &Mod.func/arity
      // LOCAL_CALL_RE は接頭辞キャプチャ付き(グループ 2 が関数名)
      LOCAL_CALL_RE.lastIndex = 0;
      for (let m = LOCAL_CALL_RE.exec(line); m; m = LOCAL_CALL_RE.exec(line)) addLocal(m[2]);
      runLocal(PIPE_LOCAL_RE); // |> func
      runLocal(CAPTURE_LOCAL_RE); // &func/arity
    }
  }
}
