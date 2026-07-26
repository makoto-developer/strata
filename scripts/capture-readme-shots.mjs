// README・ドキュメント用のスクリーンショットを light / dark 両方で撮る。
// 誰でも同じ絵を再現できるよう、対象は同梱の examples/demo に固定している。
//
//   npm install --no-save playwright
//   # 自分の projects.json(実パスや社内リポジトリ名が入っている)が写り込まないよう、
//   # 登録先を空の一時ディレクトリに向けてからサーバを起動する
//   STRATA_CONFIG_DIR=$(mktemp -d) node src/cli.ts serve examples/demo --port 7350 &
//   node scripts/capture-readme-shots.mjs http://127.0.0.1:7350/
//
// 出力: docs/assets/shots/<画面>-<light|dark>.png

import { chromium } from 'playwright';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const url = process.argv[2] || 'http://127.0.0.1:7350/';
const outDir = fileURLToPath(new URL('../docs/assets/shots/', import.meta.url));
fs.mkdirSync(outDir, { recursive: true });

const size = { width: 1280, height: 760 };
const browser = await chromium.launch({ channel: 'chrome' });

/** 台本: 画面ごとに「どう操作してから撮るか」を書く。 */
const scenes = [
  {
    name: 'structure',
    async run(page) {
      await page.click('#btn-modules');
      await page.waitForTimeout(700);
      await page.click('.row >> nth=3');
      await page.waitForTimeout(700);
    },
  },
  {
    name: 'api',
    async run(page) {
      await page.click('#tab-api');
      await page.waitForTimeout(800);
      await page.click('#apilist li.rpc-item >> nth=0', { timeout: 8000 });
      await page.waitForTimeout(1000);
    },
  },
  {
    name: 'diagram',
    async run(page) {
      await page.click('#tab-diagram');
      await page.waitForTimeout(1200);
    },
  },
  {
    name: 'entries',
    async run(page) {
      await page.click('#tab-entries');
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'projects',
    async run(page) {
      await page.click('#tab-projects');
      await page.waitForTimeout(900);
    },
  },
];

for (const theme of ['light', 'dark']) {
  for (const scene of scenes) {
    const ctx = await browser.newContext({ viewport: size, colorScheme: theme, deviceScaleFactor: 2 });
    // テーマは手動切替の保存値で固定する(OS 設定に左右されないように)
    await ctx.addInitScript((t) => {
      try {
        localStorage.setItem('strata.theme', t);
      } catch {
        /* localStorage が使えない環境では OS 設定にフォールバック */
      }
    }, theme);
    const page = await ctx.newPage();
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForSelector('.row', { timeout: 20000 });
    await page.waitForTimeout(500);
    try {
      await scene.run(page);
    } catch (err) {
      console.error(`  (skip: ${scene.name} — ${err.message.split('\n')[0]})`);
    }
    const file = path.join(outDir, `${scene.name}-${theme}.png`);
    await page.screenshot({ path: file });
    console.log(`✓ ${path.relative(process.cwd(), file)}`);
    await ctx.close();
  }
}
await browser.close();
