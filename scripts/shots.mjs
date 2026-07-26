// ビューアの全画面(構造 / API / 図 / エントリーポイント / プロジェクト / モーダル / ソース)を
// light・dark 両テーマで撮影する開発用スクリプト。デザイン変更の目視確認に使う。
//
// 使い方(Strata 本体はゼロ依存なので、撮影ツールは都度インストールする):
//   npm install --no-save playwright        # ブラウザは OS の Chrome を使うのでダウンロード不要
//   node src/cli.ts serve <対象リポジトリ> --port 7334 &
//   node scripts/shots.mjs http://127.0.0.1:7334/ /tmp/strata-shots after
//
// 出力: <出力先>-<タグ>/{light,dark}/NN-画面名.png
import { chromium } from 'playwright';
import * as fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:7334/';
const outRoot = process.argv[3] || 'scripts/.shots';
const tag = process.argv[4] || '';

const browser = await chromium.launch({ channel: 'chrome' });
const shot = async (page, dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: `${dir}/${name}.png` });
};
const safe = async (label, fn) => {
  try { await fn(); } catch (e) { console.error(`skip ${label}: ${e.message.split('\n')[0]}`); }
};

for (const scheme of ['light', 'dark']) {
  const dir = `${outRoot}${tag ? '-' + tag : ''}/${scheme}`;
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const wait = (ms) => page.waitForTimeout(ms);
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForSelector('.row', { timeout: 20000 });
  await wait(800);

  // 1. 構造ビュー(概観)
  await shot(page, dir, '01-structure-overview');

  // 2. モジュール展開 + 行フォーカス(サイドパネル)
  await safe('modules', async () => { await page.click('#btn-modules'); await wait(700); });
  await shot(page, dir, '02-structure-modules');
  await safe('focus row', async () => { await page.click('.row >> nth=4'); await wait(600); });
  await shot(page, dir, '03-structure-side');

  // 4. 検索
  await safe('search', async () => { await page.fill('#search', 'payment'); await wait(700); });
  await shot(page, dir, '04-structure-search');
  await safe('clear', async () => { await page.fill('#search', ''); await wait(400); });

  // 5. API カタログ
  await safe('api', async () => { await page.click('#tab-api'); await wait(900); });
  await shot(page, dir, '05-api-list');
  await safe('api flow', async () => { await page.click('#apilist li.rpc-item >> nth=2', { timeout: 8000 }); await wait(900); });
  await shot(page, dir, '06-api-flow');

  // 7. 図
  await safe('diagram', async () => { await page.click('#tab-diagram'); await wait(1200); });
  await shot(page, dir, '07-diagram');

  // 8. エントリーポイント
  await safe('entries', async () => { await page.click('#tab-entries'); await wait(900); });
  await shot(page, dir, '08-entries');

  // 9. プロジェクト
  await safe('projects', async () => { await page.click('#tab-projects'); await wait(700); });
  await shot(page, dir, '09-projects');

  // 10. ヘルプ
  await safe('help', async () => { await page.click('#btn-help'); await wait(500); });
  await shot(page, dir, '10-help');
  await safe('esc', async () => { await page.keyboard.press('Escape'); await wait(300); });

  // 11. スタックトレースモーダル
  await safe('stack', async () => { await page.click('#btn-stack'); await wait(400); });
  await shot(page, dir, '11-stack');
  await safe('esc', async () => { await page.keyboard.press('Escape'); await wait(300); });

  // 12. ソースビューア(構造タブから関数を開く)
  await safe('source', async () => {
    await page.click('#tab-api'); await wait(500);
    await page.click('#apilist li.rpc-item >> nth=2', { timeout: 8000 }); await wait(800);
    await page.click('#apiflow .flow .frow >> nth=1', { timeout: 8000 }); await wait(1200);
  });
  await shot(page, dir, '12-source');

  await ctx.close();
}
await browser.close();
console.log('done');
