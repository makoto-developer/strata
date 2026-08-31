// パスのグロブ照合。`**/` は 0 段以上の階層、`**` は任意(/ を含む)、`*` は 1 階層内の任意文字。
// rules.ts の依存ルール照合とは用途が違う(あちらはグロブ無しを部分一致として扱う)ため別に持つ。

/** グロブを、パス全体に対する正規表現へ変換する。 */
export function globToRegex(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    if (pattern.startsWith('**/', i)) {
      re += '(?:.*/)?';
      i += 3;
    } else if (pattern.startsWith('**', i)) {
      re += '.*';
      i += 2;
    } else if (pattern[i] === '*') {
      re += '[^/]*';
      i += 1;
    } else {
      re += pattern[i].replace(/[.+?^${}()|[\]\\]/g, '\\$&');
      i += 1;
    }
  }
  return new RegExp('^' + re + '$');
}

/** どれか 1 つのグロブに一致するか。 */
export function matchesAnyGlob(rel: string, patterns: string[]): boolean {
  return patterns.some((p) => globToRegex(p).test(rel));
}
