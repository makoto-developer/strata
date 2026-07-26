// HTTP / GraphQL といった「gRPC 以外の API 表面」を解析するアナライザ共通のユーティリティ
// (docs/SPEC.md §6.9)。
//
// これらのアナライザは言語アナライザの後段で走るため、関数ノードはすでに builder に
// 揃っている。個別に再パースせず、既存ノードの meta(file/line)から
// 「その呼び出し行を含む関数」を引くことで呼び出し元を特定する。

import { readFileText, type Ctx } from '../context.ts';

/** ws 相対パスのソースを読む。読めないファイルは解析対象から外すだけで、走査は続ける。 */
export function readSource(ctx: Ctx, wsRel: string): string | undefined {
  try {
    return readFileText(ctx, wsRel);
  } catch {
    return undefined;
  }
}

/**
 * 関数ノードを「短い名前 → ノード id」で引ける索引。レシーバ/パッケージ修飾
 * (`UserHandler.Get`)は落として最後の要素だけを鍵にする。
 * lower=true なら鍵を小文字化する(GraphQL のフィールド名は大小が揺れるため)。
 */
export function buildShortNameIndex(ctx: Ctx, lower = false): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const node of ctx.builder.nodes.values()) {
    if (node.kind !== 'func') continue;
    const label = node.label;
    const short = label.includes('.') ? label.slice(label.lastIndexOf('.') + 1) : label;
    const key = lower ? short.toLowerCase() : short;
    let list = index.get(key);
    if (!list) {
      list = [];
      index.set(key, list);
    }
    list.push(node.id);
  }
  return index;
}

/** ノード id からトップレベル(サービス/モジュール)の祖先 id を返す。 */
export function topAncestorId(ctx: Ctx, id: string): string {
  let cur = id;
  for (let guard = 0; guard < 200; guard++) {
    const node = ctx.builder.get(cur);
    if (!node || !node.parent) return cur;
    cur = node.parent;
  }
  return cur;
}

export interface FuncIndex {
  /** ws 相対ファイル → そのファイルで定義された関数(定義行の昇順) */
  byFile: Map<string, Array<{ id: string; line: number; label: string }>>;
}

/** builder 上の関数ノードから「ファイル → 関数(行順)」の索引を作る。 */
export function buildFuncIndex(ctx: Ctx): FuncIndex {
  const byFile = new Map<string, Array<{ id: string; line: number; label: string }>>();
  for (const node of ctx.builder.nodes.values()) {
    if (node.kind !== 'func') continue;
    const file = node.meta?.file;
    const line = node.meta?.line;
    if (!file || !line) continue;
    let list = byFile.get(file);
    if (!list) {
      list = [];
      byFile.set(file, list);
    }
    list.push({ id: node.id, line, label: node.label });
  }
  for (const list of byFile.values()) list.sort((a, b) => a.line - b.line);
  return { byFile };
}

/**
 * file:line を含む関数ノード id を返す。関数の終了行は持っていないので
 * 「その行より前で最も近い関数定義」を採用する(入れ子は外側の関数に寄せる)。
 * 該当がなければファイルノード(トップレベルのコード)を返す。
 */
export function enclosingNodeId(ctx: Ctx, index: FuncIndex, file: string, line: number): string {
  const list = index.byFile.get(file);
  if (list && list.length > 0) {
    let best: string | undefined;
    for (const fn of list) {
      if (fn.line <= line) best = fn.id;
      else break;
    }
    if (best) return best;
  }
  return ctx.builder.get(file) ? file : '';
}

/**
 * URL / ルートパスを比較用に正規化する。
 *   https://order-svc:8080/api/orders/{id}?x=1  →  /api/orders/{}
 *   /api/orders/:id                            →  /api/orders/{}
 *   /api/orders/%s                             →  /api/orders/{}
 * ホスト部は捨てる(サービス名は呼び出し側の変数や env に隠れていることが多く、
 * パス一致のほうが安定して当たる)。
 */
export function normalizePath(raw: string): string {
  let s = raw.trim();
  if (s === '') return '';
  // スキーム + ホストを落とす
  const scheme = /^[a-zA-Z][\w+.-]*:\/\//.exec(s);
  if (scheme) {
    const rest = s.slice(scheme[0].length);
    const slash = rest.indexOf('/');
    s = slash < 0 ? '/' : rest.slice(slash);
  } else if (/^[\w.-]+(:\d+)?\//.test(s) && !s.startsWith('/')) {
    // host/path 形式(スキームなし)
    s = s.slice(s.indexOf('/'));
  }
  // 先頭がホストのプレースホルダ(`${BASE}/api/x` / `{base}/api/x`)ならその 1 区画を落とす
  s = s.replace(/^\$?\{[^}]*\}(?=\/)/, '');
  s = s.split('?')[0].split('#')[0];
  // テンプレート/フォーマット/パラメータをワイルドカードに寄せる
  s = s
    .replace(/\$\{[^}]*\}/g, '{}') // `${id}`(JS テンプレートリテラル)
    .replace(/%[sdvq]/g, '{}') // fmt.Sprintf
    .replace(/\{[^}]*\}/g, '{}') // {id} / {id:int}
    .replace(/<[^>]*>/g, '{}') // <int:id>(Flask)
    .replace(/:[A-Za-z_][\w-]*/g, '{}') // :id(gin/express)
    .replace(/\*+/g, '{}'); // ワイルドカード
  s = s.replace(/\/{2,}/g, '/');
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s;
}

/** 正規化したパスから比較キーを作る(大文字小文字は無視)。 */
export function pathKey(method: string, path: string): string {
  return method.toUpperCase() + ' ' + normalizePath(path).toLowerCase();
}

/** ルートパスやハンドラ名から webhook 受信口らしさを判定する。 */
export function looksLikeWebhook(text: string): boolean {
  return /webhook|web_hook|web-hook|\bhooks?\b/i.test(text);
}
