// テキスト解析の共通処理: コメント・文字列リテラルの無害化(docs/SPEC.md §6.1)
//
// - noComments: コメントだけを空白化(文字列は残す)。import 文の抽出に使う
// - blanked:    コメントと文字列の中身を空白化。ブレース対応・呼び出し抽出に使う
// 改行は必ず保持する(行番号計算のため)。

export interface Stripped {
  noComments: string;
  blanked: string;
}

export function stripSource(src: string, lang: 'go' | 'js'): Stripped {
  const n = src.length;
  const noComments: string[] = new Array(n);
  const blanked: string[] = new Array(n);
  let state:
    | 'code'
    | 'line-comment'
    | 'block-comment'
    | 'dquote'
    | 'squote'
    | 'backtick'
    | 'regex' = 'code';

  const put = (i: number, ch: string, keepInNoComments: boolean, keepInBlanked: boolean): void => {
    const isNl = ch === '\n';
    noComments[i] = isNl || keepInNoComments ? ch : ' ';
    blanked[i] = isNl || keepInBlanked ? ch : ' ';
  };

  // JS の `/` は除算にも正規表現リテラルにもなる。直前の「有効な」トークン
  // (空白・コメントを除いた最後のコード文字)を見て判別する。式が来うる位置
  // (代入・演算子・開き括弧・特定キーワードの直後)なら正規表現とみなす。
  // これをしないと /['"]/ の中の引用符がクォート状態を開始し、以降のソースが
  // まるごと無害化されて関数・呼び出しが検出できなくなる。
  let lastSig = ''; // 直前の有効コード文字
  let lastSigIndex = -1;
  const EXPR_PREV = new Set([
    '(', '[', '{', ',', ';', ':', '=', '!', '&', '|', '?', '+', '-', '*', '%', '<', '>', '^', '~',
  ]);
  const REGEX_KEYWORDS = new Set([
    'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'do', 'else', 'yield',
    'await', 'throw', 'case',
  ]);
  const isWordChar = (c: string): boolean =>
    (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c === '_' || c === '$';
  const regexAllowed = (): boolean => {
    if (lastSig === '') return true; // ファイル先頭 / 直前が空白・コメントのみ
    if (EXPR_PREV.has(lastSig)) return true;
    if (/[A-Za-z_$]/.test(lastSig)) {
      let j = lastSigIndex;
      while (j >= 0 && isWordChar(src[j])) j--;
      return REGEX_KEYWORDS.has(src.slice(j + 1, lastSigIndex + 1));
    }
    return false; // 識別子・数値・) ] } " ' ` の直後は除算
  };
  let inCharClass = false; // 正規表現内の [...] 文字クラス中は / が区切りにならない

  for (let i = 0; i < n; i++) {
    const ch = src[i];
    const next = i + 1 < n ? src[i + 1] : '';
    switch (state) {
      case 'code':
        if (ch === '/' && next === '/') {
          state = 'line-comment';
          put(i, ch, false, false);
        } else if (ch === '/' && next === '*') {
          state = 'block-comment';
          put(i, ch, false, false);
        } else if (lang === 'js' && ch === '/' && regexAllowed()) {
          state = 'regex';
          inCharClass = false;
          put(i, ch, false, false); // 正規表現は文字列同様に中身を無害化する
        } else if (ch === '"') {
          state = 'dquote';
          put(i, ch, true, true); // 引用符自体は残す
        } else if (ch === "'") {
          state = 'squote';
          put(i, ch, true, true);
        } else if (ch === '`') {
          state = 'backtick';
          put(i, ch, true, true);
        } else {
          put(i, ch, true, true);
          if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') {
            lastSig = ch; // `/`(除算)含む通常コード文字を有効トークンとして記録
            lastSigIndex = i;
          }
        }
        break;
      case 'regex':
        if (ch === '\\' && i + 1 < n) {
          put(i, ch, false, false);
          i++;
          put(i, src[i], false, false);
        } else if (ch === '\n') {
          put(i, ch, false, false); // 未終了(不正)の正規表現は行末で打ち切る
          state = 'code';
        } else if (ch === '[') {
          inCharClass = true;
          put(i, ch, false, false);
        } else if (ch === ']') {
          inCharClass = false;
          put(i, ch, false, false);
        } else if (ch === '/' && !inCharClass) {
          put(i, ch, false, false);
          state = 'code';
          lastSig = '/'; // 正規表現の直後は値なので続く / は除算
          lastSigIndex = i;
        } else {
          put(i, ch, false, false);
        }
        break;
      case 'line-comment':
        if (ch === '\n') state = 'code';
        put(i, ch, false, false);
        break;
      case 'block-comment':
        if (ch === '*' && next === '/') {
          put(i, ch, false, false);
          i++;
          put(i, '/', false, false);
          state = 'code';
        } else {
          put(i, ch, false, false);
        }
        break;
      case 'dquote':
        if (ch === '\\' && i + 1 < n) {
          put(i, ch, true, false);
          i++;
          put(i, src[i], true, false);
        } else {
          put(i, ch, true, ch === '"'); // noComments には文字列を残す
          if (ch === '"') {
            state = 'code';
            lastSig = '"';
            lastSigIndex = i;
          }
        }
        break;
      case 'squote':
        if (ch === '\\' && i + 1 < n) {
          put(i, ch, true, false);
          i++;
          put(i, src[i], true, false);
        } else {
          put(i, ch, true, ch === "'");
          if (ch === "'") {
            state = 'code';
            lastSig = "'";
            lastSigIndex = i;
          }
        }
        break;
      case 'backtick':
        // Go の raw string / JS のテンプレートリテラル。
        // JS の ${...} 補間内の呼び出しは追跡しない(仕様 §6.6 の限界事項)。
        if (lang === 'js' && ch === '\\' && i + 1 < n) {
          put(i, ch, true, false);
          i++;
          put(i, src[i], true, false);
        } else {
          put(i, ch, true, ch === '`');
          if (ch === '`') {
            state = 'code';
            lastSig = '`';
            lastSigIndex = i;
          }
        }
        break;
    }
  }
  return { noComments: noComments.join(''), blanked: blanked.join('') };
}

/** 1 始まりの行番号を返す関数を作る。 */
export function makeLineFinder(src: string): (index: number) => number {
  const starts: number[] = [0];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1);
  }
  return (index: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= index) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** blanked ソース上で openIndex('{' の位置)に対応する '}' の位置を返す。見つからなければ -1。 */
export function matchBrace(blanked: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < blanked.length; i++) {
    const ch = blanked[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * 宣言行の直上にある連続コメントを説明文として抽出する(godoc / proto コメント規約)。
 * `//` 行コメントの連続ブロック、または直上で閉じる `/* ... *​/` ブロックに対応。
 * lines は分割済みソース、declLine は 1 始まり。見つからなければ undefined。
 */
export function leadingComment(lines: string[], declLine: number): string | undefined {
  const out: string[] = [];
  let i = declLine - 2; // 宣言の 1 行上(0 始まり index)
  // 直上がブロックコメントの終端の場合
  // 直上がブロックコメントの終端 `*/` の場合。ただし `x = 3 /* trailing */` のような
  // コード行末の行内コメントを誤って取り込まないよう、その行自体がコメント行
  // (`/*` か `*` で始まる)であることを要求する。上限行数も設けて暴走を防ぐ。
  if (i >= 0 && lines[i].trim().endsWith('*/') && /^(\/\*|\*)/.test(lines[i].trim())) {
    const block: string[] = [];
    const floor = Math.max(0, i - 40);
    let found = false;
    for (; i >= floor; i--) {
      const t = lines[i].trim();
      block.push(t.replace(/^\/\*+/, '').replace(/\*+\/$/, '').replace(/^\*\s?/, '').trim());
      if (t.startsWith('/*')) {
        found = true;
        break;
      }
    }
    if (!found) return undefined; // 40 行内に `/*` 開始が見つからない = コメントではない
    block.reverse();
    const text = block.join(' ').trim();
    return text === '' ? undefined : clipDoc(text);
  }
  for (; i >= 0; i--) {
    const t = lines[i].trim();
    if (!t.startsWith('//')) break;
    out.push(t.replace(/^\/\/+\s?/, ''));
  }
  if (out.length === 0) return undefined;
  out.reverse();
  const text = out.join(' ').trim();
  return text === '' ? undefined : clipDoc(text);
}

function clipDoc(text: string): string {
  return text.length > 280 ? text.slice(0, 277) + '…' : text;
}

export function countLines(src: string): number {
  if (src.length === 0) return 0;
  let count = 1;
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') count++;
  }
  return count;
}
