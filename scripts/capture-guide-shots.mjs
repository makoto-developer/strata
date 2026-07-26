// ドキュメントサイトの操作説明用に、画面の各パーツを切り出して撮る。
// README 用の全景(capture-readme-shots.mjs)とは別に、「ボタンの説明」「読み方の説明」に
// 使う拡大画像をここで作る。
//
//   npm install --no-save playwright
//   STRATA_CONFIG_DIR=$(mktemp -d) node src/cli.ts serve /tmp/strata/examples/demo --port 7360 &
//   node scripts/capture-guide-shots.mjs http://127.0.0.1:7360/
//
// 出力: docs/assets/guide/<名前>-<light|dark>.png
//
// 撮影対象は「要素の位置から切り出し範囲を決める」方式にしている。
// 座標を直書きすると、文言やレイアウトを変えたときに無言でズレるため。

import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] || 'http://127.0.0.1:7360/';
const outDir = fileURLToPath(new URL('../docs/assets/guide/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: 'chrome' });

/** 要素の矩形を余白つきで返す(画面外にはみ出さないよう丸める)。 */
async function clipOf(page, selector, pad = 8, opts = {}) {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`要素が見つかりません: ${selector}`);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return {
    x,
    y,
    width: Math.min(opts.width ?? box.width + pad * 2, 1280 - x),
    height: Math.min(opts.height ?? box.height + pad * 2, 800 - y),
  };
}

const scenes = [
  {
    name: 'toolbar-main',
    async run(page) {
      return clipOf(page, '#topbar .bar-main', 10);
    },
  },
  {
    name: 'toolbar-context',
    async run(page) {
      return clipOf(page, '#topbar .bar-context', 10);
    },
  },
  {
    name: 'row-anatomy',
    async run(page) {
      await page.click('#btn-modules');
      await page.waitForTimeout(600);
      const box = await page.locator('.row').nth(1).boundingBox();
      return { x: 60, y: box.y - 14, width: 620, height: 130 };
    },
  },
  {
    name: 'arcs',
    async run(page) {
      await page.click('#btn-modules');
      await page.waitForTimeout(700);
      await page.hover('.row >> nth=6');
      await page.waitForTimeout(500);
      return { x: 0, y: 95, width: 560, height: 320 };
    },
  },
  {
    name: 'api-list',
    async run(page) {
      await page.click('#tab-api');
      await page.waitForTimeout(900);
      return { x: 0, y: 300, width: 340, height: 380 };
    },
  },
  {
    name: 'api-flow',
    async run(page) {
      await page.click('#tab-api');
      await page.waitForTimeout(800);
      await page.click('#apilist li.rpc-item >> nth=0', { timeout: 8000 });
      await page.waitForTimeout(1000);
      return clipOf(page, '#apiflow', 0, { width: 520, height: 420 });
    },
  },
  {
    name: 'source',
    async run(page) {
      await page.click('#tab-api');
      await page.waitForTimeout(800);
      await page.click('#apilist li.rpc-item >> nth=0', { timeout: 8000 });
      await page.waitForTimeout(1200);
      return clipOf(page, '#apisrc', 0, { width: 560, height: 380 });
    },
  },
  {
    name: 'diagram',
    async run(page) {
      await page.click('#tab-diagram');
      await page.waitForTimeout(1300);
      return { x: 120, y: 60, width: 900, height: 430 };
    },
  },
  {
    name: 'entries',
    async run(page) {
      await page.click('#tab-entries');
      await page.waitForTimeout(900);
      return { x: 120, y: 60, width: 900, height: 330 };
    },
  },
  {
    name: 'help',
    async run(page) {
      await page.click('#btn-help');
      await page.waitForTimeout(500);
      return clipOf(page, '#helpmodal .helpbox', 12);
    },
  },
  {
    name: 'legend',
    async run(page) {
      return clipOf(page, '#legend', 6);
    },
  },
];

for (const theme of ['light', 'dark']) {
  for (const scene of scenes) {
    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      colorScheme: theme,
      deviceScaleFactor: 2,
    });
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('strata.theme', t);
      } catch {
        /* localStorage が無い環境では OS 設定に従う */
      }
    }, theme);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.row', { timeout: 20000 });
    await page.waitForTimeout(400);
    try {
      const clip = await scene.run(page);
      const file = path.join(outDir, `${scene.name}-${theme}.png`);
      await page.screenshot({ path: file, clip });
      console.log(`✓ ${path.relative(process.cwd(), file)}`);
    } catch (err) {
      console.error(`✖ ${scene.name}-${theme}: ${err.message.split('\n')[0]}`);
    }
    await ctx.close();
  }
}
await browser.close();
