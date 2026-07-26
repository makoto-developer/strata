// Strata ビューアのデモ GIF を再現可能に生成する開発用スクリプト。
// Playwright(ヘッドレス Chromium)でビューアを台本どおり操作し、動画に録る。
//
// 使い方(Strata 本体はゼロ依存なので、録画ツールは都度インストールする):
//   npm install --no-save playwright && npx playwright install chromium
//   node src/cli.ts serve examples/demo --port 7455 &   # サーバを起動
//   node scripts/record-demo.mjs http://127.0.0.1:7455/ scripts/.rec
//   # 出力された .webm を ffmpeg で GIF 化(README 用)
//
// 出力: 指定ディレクトリに .webm を書き出し、そのパスを JSON で表示する。

import { chromium } from 'playwright';
import * as fs from 'node:fs';

const url = process.argv[2] || 'http://127.0.0.1:7333/';
const outDir = process.argv[3] || 'scripts/.rec';
fs.mkdirSync(outDir, { recursive: true });

const size = { width: 1360, height: 840 };
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: size, recordVideo: { dir: outDir, size } });
const page = await context.newPage();
const wait = (ms) => page.waitForTimeout(ms);
const safe = async (label, fn) => {
  try {
    await fn();
  } catch (err) {
    console.error(`  (skip: ${label} — ${err.message.split('\n')[0]})`);
  }
};

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForSelector('.row', { timeout: 15000 });
await wait(1200);

// 概観 → モジュールまで展開
await safe('expand modules', () => page.click('#btn-modules'));
await wait(1300);

// 行をフォーカス(依存線ハイライト + 詳細パネル)
const rows = page.locator('.row');
await safe('focus row', () => rows.nth(2).click());
await wait(1400);
await safe('hover row', () => rows.nth(6).hover());
await wait(1300);

// 検索フィルタ
await safe('search', () => page.fill('#search', 'handle'));
await wait(1700);
await safe('clear search', () => page.fill('#search', ''));
await wait(700);

// ブックマーク(b キー)
await safe('bookmark', async () => {
  await rows.nth(3).click();
  await page.keyboard.press('b');
});
await wait(1300);

// API タブ → RPC を選んでフロー表示
await safe('tab api', () => page.click('#tab-api'));
await wait(1400);
await safe('open rpc', () => page.locator('#apilist li.rpc-item').first().click());
await wait(2000);

// 図タブ → ノード選択
await safe('tab diagram', () => page.click('#tab-diagram'));
await wait(1600);
await safe('diagram node', () => page.locator('#dg-svg .dg-node').first().click());
await wait(1700);

// 構造へ戻る
await safe('tab structure', () => page.click('#tab-structure'));
await wait(1100);

await context.close(); // ← ここで動画が確定・保存される
await browser.close();

const files = fs.readdirSync(outDir).filter((f) => f.endsWith('.webm'));
console.log(JSON.stringify({ video: files.length ? `${outDir}/${files[0]}` : null }));
