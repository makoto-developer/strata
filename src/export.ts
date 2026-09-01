// 自己完結 HTML の生成(docs/SPEC.md §8.4)。CSS/JS/モデルをすべてインライン化する。

import type { Graph } from './model.ts';
import { readWebAsset } from './server.ts';

export function exportHtml(model: Graph): string {
  const read = (name: string): string => {
    const buf = readWebAsset(name);
    if (buf === null) throw new Error(`ビューアの資産が見つかりません: ${name}`);
    return buf.toString('utf8');
  };
  const html = read('index.html');
  const css = read('style.css');
  const js = read('app.js');
  // インライン化した JS / JSON が <script> を閉じてしまわないようにする。
  // `<` を < にすれば "</script>" も U+2028/2029 も安全に埋め込める。
  const json = JSON.stringify(model).replace(/</g, '\\u003c');

  // 置換文字列に `$&`(マッチ全体)や `$1` があると String.replace に解釈され、
  // 差し込んだ JS の中に元の <script src="app.js"></script> が現れて script が
  // 途中で閉じてしまう。実際 web/app.js のハイライト処理に `'\\$&'` があり、
  // エクスポートした HTML が壊れていた。関数形式の置換で literal 挿入にする。
  const put = (source: string, needle: string, replacement: string): string => {
    if (!source.includes(needle)) throw new Error(`ビューアのテンプレートに ${needle} がありません`);
    return source.replace(needle, () => replacement);
  };

  // 起動オーバーレイはサーバ経由の解析待ち用。モデルを埋め込んだ HTML には出番がなく、
  // JS が無効・失敗したときに不透明な板だけが残るので取り除く
  const noBoot = html.replace(/^.*id="boot".*\n/m, '');

  return put(
    put(noBoot, '<link rel="stylesheet" href="style.css">', `<style>\n${css}\n</style>`),
    '<script src="app.js"></script>',
    `<script>window.STRATA_MODEL = ${json};</script>\n<script>\n${js}\n</script>`,
  );
}
