// ビューアの全ボタン・全画面を実ブラウザで一通り操作し、
// 「押しても何も起きない」「JS エラーが出る」「期待した画面が出ない」を洗い出す監査スクリプト。
//
// DOM スタブのスモークテスト(test/viewer.smoke.mjs)では拾えない
// 「実ブラウザでの通信・レンダリング・イベント順序」を確認するためのもの。
//
// 使い方(Strata 本体はゼロ依存なので、監査ツールは都度インストールする):
//   npm install --no-save playwright        # ブラウザは OS の Chrome を使うのでダウンロード不要
//   node src/cli.ts serve examples/demo --port 7334 &
//   node scripts/audit-viewer.mjs http://127.0.0.1:7334/
//
// 判定を書くときの注意:
//   - 表示深度のボタンは「全展開した状態から押す」で前提を揃える(既定状態から押すと変化しない)
//   - 検索は行を消さず非一致を減光する(SPEC §8)。行数ではなく `.row:not(.dim)` で数える
import { chromium } from 'playwright';

const url = process.argv[2];
const browser = await chromium.launch({ channel: 'chrome' });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
page.on('requestfailed', (r) => errors.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

const rows = [];
const record = (name, ok, detail) => rows.push({ name, ok, detail });

/** 操作前後で DOM が変わったか / 期待条件を満たすかを見る汎用チェック */
async function probe(name, selector, expect) {
  const before = await page.content();
  const errBefore = errors.length;
  try {
    await page.click(selector, { timeout: 4000 });
  } catch (e) {
    record(name, false, '押せない: ' + e.message.split('\n')[0]);
    return;
  }
  await page.waitForTimeout(500);
  const after = await page.content();
  const newErrors = errors.slice(errBefore);
  if (newErrors.length) { record(name, false, 'JS エラー: ' + newErrors.join(' / ')); return; }
  if (expect) {
    const r = await expect();
    record(name, r === true, r === true ? '' : String(r));
    return;
  }
  record(name, before !== after, before !== after ? '' : '押しても DOM が変わらない');
}

const visible = (sel) => page.$eval(sel, (el) => !el.classList.contains('hidden')).catch(() => false);
const text = (sel) => page.textContent(sel).catch(() => '');

await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(1800);

// 起動オーバーレイ: 消し忘れると画面全体を覆って何も操作できなくなる
{
  const boot = await page.evaluate(() => {
    const el = document.querySelector('#boot');
    if (!el) return { gone: true };
    const r = el.getBoundingClientRect();
    return { gone: false, w: Math.round(r.width), h: Math.round(r.height) };
  });
  record('起動オーバーレイが消えている', boot.gone, boot.gone ? '' : `残っている ${boot.w}x${boot.h}`);
}

// 待たせる画面のローディング表示(/source を遅らせて確かめる)
{
  await page.route('**/source*', async (route) => {
    await new Promise((r) => setTimeout(r, 1200));
    await route.continue();
  });
  await page.click('#tab-api');
  await page.waitForTimeout(800);
  const shown = await page.evaluate(() => {
    const it = document.querySelector('#apilist .rpc-item');
    if (it) it.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return !!it;
  });
  await page.waitForTimeout(700);
  await page.evaluate(() => {
    const fn = document.querySelector('#apiflow [data-id]');
    if (fn) fn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await page.waitForTimeout(300);
  const loading = await page.evaluate(() => {
    const box = document.querySelector('#apisrc .loadbox');
    if (!box) return { box: false };
    const spin = box.querySelector('.spin');
    const r = spin ? spin.getBoundingClientRect() : { width: 0 };
    return { box: true, text: box.textContent.trim(), spin: Math.round(r.width) };
  });
  await page.waitForTimeout(1500);
  const done = await page.evaluate(() => ({
    box: !!document.querySelector('#apisrc .loadbox'),
    code: !!document.querySelector('#apisrc pre.code'),
  }));
  await page.unroute('**/source*');
  record('ソース読み込み中にローディングが出る', shown && loading.box && loading.spin > 0,
    loading.box ? `${loading.text}(spinner ${loading.spin}px)` : 'ローディングが出ない');
  record('読み込み後はローディングが消えてコードが出る', !done.box && done.code, JSON.stringify(done));
}

// ---------- タブ ----------
const tabs = [
  ['構造', '#tab-structure', '#main'],
  ['API', '#tab-api', '#apiview'],
  ['図', '#tab-diagram', '#diagramview'],
  ['エントリーポイント', '#tab-entries', '#entriesview'],
  ['差分', '#tab-diff', '#diffview'],
  ['プロジェクト', '#tab-projects', '#projview'],
];
for (const [label, tab, view] of tabs) {
  await probe(`タブ: ${label}`, tab, async () => {
    if (!(await visible(view))) return `${view} が表示されない`;
    const t = (await text(view)) || '';
    if (t.trim() === '' && view !== '#main') return `${view} が空`;
    const others = tabs.filter(([, , v]) => v !== view);
    for (const [, , v] of others) if (await visible(v)) return `${v} が同時に表示されている`;
    return true;
  });
}

// ---------- 構造タブのツールバー ----------
await page.click('#tab-structure');
await page.waitForTimeout(400);
const rowCount = () => page.$$eval('#tree .row', (r) => r.length);

// 表示深度のボタンは「全展開した状態から押す」で揃えないと変化が出ない
for (const [label, sel] of [['概観', '#btn-overview'], ['モジュール', '#btn-modules'], ['折りたたみ', '#btn-collapse']]) {
  await page.click('#btn-expand');
  await page.waitForTimeout(400);
  const before = await rowCount();
  await page.click(sel);
  await page.waitForTimeout(400);
  const after = await rowCount();
  record(`ツールバー: ${label}`, after < before, `全展開 ${before} 行 → ${after} 行`);
}
{
  await page.click('#btn-collapse');
  await page.waitForTimeout(400);
  const before = await rowCount();
  await page.click('#btn-expand');
  await page.waitForTimeout(400);
  const after = await rowCount();
  record('ツールバー: 全展開', after > before, `折りたたみ ${before} 行 → ${after} 行`);
}

// 検索(SPEC §8: 行は消さず、非一致を減光する。件数は下部バーに出す)
await page.click('#btn-expand');
await page.waitForTimeout(500);
const lit = () => page.$$eval('#tree .row:not(.dim)', (r) => r.length);
await page.fill('#search', 'user');
await page.waitForTimeout(700);
const total = await rowCount();
const hitRows = await lit();
const hitBadge = ((await text('#stats')) || '').includes('一致');
record('検索: 一致を強調し非一致を減光', hitRows > 0 && hitRows < total, `全 ${total} 行中 ${hitRows} 行を強調`);
record('検索: 件数を下部バーに表示', hitBadge, hitBadge ? '' : '「一致 n」が出ない');
await page.fill('#search', 'zzzznotexist');
await page.waitForTimeout(700);
const noneBadge = ((await text('#stats')) || '').includes('一致なし');
record('検索: 該当ゼロの明示', noneBadge && (await lit()) === 0, noneBadge ? '' : '「一致なし」が出ない');
await page.fill('#search', '');
await page.waitForTimeout(700);
record('検索: 解除で全行が戻る', (await lit()) === (await rowCount()), '');

// 並び替え
const sortOpts = await page.$$eval('#sort option', (o) => o.map((x) => x.value));
let sortOk = true;
let sortDetail = '';
for (const v of sortOpts) {
  const errBefore = errors.length;
  await page.selectOption('#sort', v);
  await page.waitForTimeout(350);
  const n = await rowCount();
  if (errors.length > errBefore || n === 0) { sortOk = false; sortDetail += `${v}=NG `; }
}
record('並び替え(全選択肢)', sortOk, sortDetail || sortOpts.join(' / '));

// テーマ切替(自動→ライト→ダーク の巡回)
const themes = [];
for (let i = 0; i < 3; i++) {
  await page.click('#btn-theme');
  await page.waitForTimeout(250);
  themes.push(await page.evaluate(() => document.documentElement.getAttribute('data-theme') || '(自動)'));
}
record('テーマ切替', new Set(themes).size >= 2, themes.join(' → '));

// 履歴(戻る / 進む)・再解析・ヘルプ・スタックトレース
await probe('ヘルプ(?)', '#btn-help', async () => ((await text('body')) || '').includes('ショートカット') ? true : 'ショートカット一覧が出ない');
await page.keyboard.press('Escape');
await page.waitForTimeout(300);

await probe('スタックトレース', '#btn-stack', async () => (await visible('#stackmodal')) ? true : 'モーダルが開かない');
await page.fill('#stack-input', 'handler.go:17');
await probe('スタックトレース: 解析', '#stack-parse', async () => {
  const t = (await text('#stack-results')) || '';
  return t.trim() !== '' ? true : '結果が空';
});
await probe('スタックトレース: 閉じる', '#stack-close', async () => (await visible('#stackmodal')) ? 'モーダルが閉じない' : true);

// フォーカス移動 → 戻る/進むが機能するか
await page.click('#tab-structure');
await page.waitForTimeout(300);
const firstRow = await page.$('#tree .row');
if (firstRow) { await firstRow.click(); await page.waitForTimeout(400); }
const secondRow = (await page.$$('#tree .row'))[2];
if (secondRow) { await secondRow.click(); await page.waitForTimeout(400); }
await probe('履歴: 戻る', '#btn-back', async () => true);
await probe('履歴: 進む', '#btn-fwd', async () => true);

// 再解析
await probe('再解析(⟳)', '#btn-reload', async () => ((await rowCount()) > 0 ? true : 'ツリーが空になった'));

// ---------- ヘッダのリンク ----------
for (const [label, sel] of [['説明書リンク', '#docslink'], ['ソースリンク', '#srclink'], ['ロゴ', '#logo'], ['ワークスペース名', '#wsname']]) {
  const el = await page.$(sel);
  if (!el) { record(label, false, '要素が無い'); continue; }
  const href = await el.getAttribute('href');
  record(label, true, href ? `href=${href}` : '(クリック動作)');
}

// ---------- API タブ ----------
await page.click('#tab-api');
await page.waitForTimeout(800);
const apiItems = await page.$$eval('#apilist [data-rpc], #apilist .apirow, #apilist li', (e) => e.length).catch(() => 0);
// 取り込んだ proto カタログのうち、使っていない定義を隠すトグル
{
  await page.evaluate(() => { if (!document.querySelector('.filters')) document.querySelector('.ftoggle').click(); });
  await page.waitForTimeout(300);
  const n = () => page.evaluate(() => document.querySelectorAll('#apilist .rpc-item').length);
  const chip = await page.$('[data-chip-excl="used"]');
  if (!chip) {
    record('API: 「コードに出てくるものだけ」', false, 'チップが無い');
  } else {
    const before = await n();
    await page.click('[data-chip-excl="used"]');
    await page.waitForTimeout(400);
    const off = await n();
    await page.click('[data-chip-excl="used"]');
    await page.waitForTimeout(400);
    const back = await n();
      record('API: 「コードに出てくるものだけ」で絞れて戻せる', off > before && back === before, `${before} → ${off} → ${back}`);
  }
  {
    // mock 除外チップ(このデモにモックは無いので、押せて例外が出ないことを見る)
    const before = errors.length;
    const toggled = await page.evaluate(() => {
      const pick = () => document.querySelector('[data-chip-excl="mocks"]');
      if (!pick()) return null;
      // クリックで再描画されるので、状態は毎回引き直したノードから読む
      pick().click();
      const on = pick().classList.contains('on');
      pick().click();
      return { on, off: !pick().classList.contains('on') };
    });
    await page.waitForTimeout(400);
    record('API: 「mock を除外」チップが動く', !!toggled && toggled.on && toggled.off && errors.length === before,
      toggled ? JSON.stringify(toggled) : 'チップが無い');
  }
}

record('API: カタログ描画', apiItems > 0, `${apiItems} 件`);
const firstApi = await page.$('#apilist [data-rpc]');
if (firstApi) {
  await firstApi.click();
  await page.waitForTimeout(700);
  const flow = ((await text('#apiflow')) || '').trim();
  record('API: フロー表示', flow !== '', flow === '' ? 'クリックしてもフローが空' : '');
} else {
  record('API: フロー表示', false, '[data-rpc] が見つからない');
}

// ---------- 図タブ ----------
await page.click('#tab-diagram');
await page.waitForTimeout(900);
const svgBoxes = await page.$$eval('#diagramview svg *', (e) => e.length).catch(() => 0);
record('図: SVG 描画', svgBoxes > 0, `${svgBoxes} 要素`);

// 図は viewBox で表示範囲を決める。折り返し・ラベルの重なり・拡大縮小は
// ソースを読んでも分からないので、実ブラウザで測る
{
  const geom = await page.evaluate(() => {
    const svg = document.querySelector('#dg-svg');
    if (!svg) return null;
    const vb = svg.getAttribute('viewBox').split(' ').map(Number);
    const boxes = [...svg.querySelectorAll('.dg-node rect')].map((r) => ({
      x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'),
    }));
    // 見出しだけでなく副題(⚡RPC ・ loc ・ ⇠N 依存元)も箱に収まっているか見る
    let clipped = 0;
    for (const g of svg.querySelectorAll('.dg-node')) {
      const rect = g.querySelector('rect');
      if (!rect) continue;
      const w = +rect.getAttribute('width');
      for (const t of g.querySelectorAll('.dg-label, .dg-sub')) {
        if (t.textContent && t.getComputedTextLength() > w - 8) clipped++;
      }
    }
    const ls = [...svg.querySelectorAll('.dg-elabel:not(.hidden)')].map((t) => t.getBBox());
    let overlap = 0;
    for (let i = 0; i < ls.length; i++) {
      for (let j = i + 1; j < ls.length; j++) {
        const a = ls[i];
        const b = ls[j];
        if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) overlap++;
      }
    }
    const r = svg.getBoundingClientRect();
    return {
      vb, overlap, clipped,
      right: Math.max(...boxes.map((b) => b.x + b.w)), bottom: Math.max(...boxes.map((b) => b.y + b.h)),
      scale: Math.min(r.width / vb[2], r.height / vb[3]),
      bodyOverflow: document.body.scrollWidth - document.body.clientWidth,
    };
  });
  record('図: 箱が SVG に収まる', geom && geom.right <= geom.vb[2] && geom.bottom <= geom.vb[3],
    geom ? `右 ${Math.round(geom.right)}/${geom.vb[2]} 下 ${Math.round(geom.bottom)}/${geom.vb[3]}` : 'SVG なし');
  record('図: 横スクロールが出ない', geom && geom.bodyOverflow <= 1, geom ? `はみ出し ${geom.bodyOverflow}px` : '');
  record('図: ラベルの文字切れなし', geom && geom.clipped === 0, geom ? `${geom.clipped} 件` : '');
  record('図: 境界ラベルが重ならない', geom && geom.overlap === 0, geom ? `${geom.overlap} 組` : '');
  record('図: 初期表示で拡大しない', geom && geom.scale <= 1.02, geom ? `倍率 ${geom.scale.toFixed(2)}` : '');

  const ui = await page.evaluate(() => {
    const svg = document.querySelector('#dg-svg');
    const boxes = [...svg.querySelectorAll('.dg-node > rect:first-of-type')].map((r) => ({
      x: +r.getAttribute('x'), y: +r.getAttribute('y'), w: +r.getAttribute('width'), h: +r.getAttribute('height'),
    }));
    const bandHit = [...svg.querySelectorAll('.dg-lvl')].filter((t) => {
      const b = t.getBBox();
      return boxes.some((x) => b.x < x.x + x.w && x.x < b.x + b.width && b.y < x.y + x.h && x.y < b.y + b.height);
    }).map((t) => t.textContent);
    const bands = [...svg.querySelectorAll('.dg-lvl')].map((t) => t.textContent);
    const langBars = [...svg.querySelectorAll('.dg-node .dg-langbar')].filter((r) => {
      const f = getComputedStyle(r).fill;
      return f && f !== 'none' && f !== 'rgba(0, 0, 0, 0)';
    }).length;
    const before = svg.querySelectorAll('.dg-node').length;
    const input = document.querySelector('#dg-q');
    const label = svg.querySelector('.dg-node .dg-label').textContent;
    input.value = label.slice(0, Math.max(3, label.length - 1));
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const dim = svg.querySelectorAll('.dg-node.dim').length;
    input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#dg-api').click();
    const apiOnly = document.querySelectorAll('#dg-svg .dg-node').length;
    document.querySelector('#dg-api').click();
    return { bands, bandHit, langBars, before, dim, apiOnly, restored: document.querySelectorAll('#dg-svg .dg-node').length,
      hasQ: !!document.querySelector('#dg-q'), hasHop: !!document.querySelector('#dg-hop') };
  });
  record('図: 帯が「依存の深さ」', ui.bands.every((t) => t === '独立' || /^依存の深さ \d+$/.test(t)), ui.bands.join(' / '));
  record('図: 帯のラベルが箱と重ならない', ui.bandHit.length === 0, ui.bandHit.join(' / '));
  record('図: 言語の色帯が塗られる', ui.langBars > 0, `${ui.langBars} 個`);
  record('図: 絞り込み UI がある', ui.hasQ && ui.hasHop, '');
  record('図: 検索で一致しない箱が減光', ui.dim > 0 && ui.dim < ui.before, `${ui.dim}/${ui.before}`);
  record('図: 「API のみ」で絞れて戻せる', ui.apiOnly <= ui.before && ui.restored === ui.before,
    `${ui.before} → ${ui.apiOnly} → ${ui.restored}`);

  const zoom = await page.evaluate(() => {
    const svg = document.querySelector('#dg-svg');
    const vw = () => Number(svg.getAttribute('viewBox').split(' ')[2]);
    const fit = vw();
    document.querySelector('#dg-in').click();
    const zin = vw();
    document.querySelector('#dg-fit').click();
    const back = vw();
    svg.focus();
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '+', bubbles: true, cancelable: true }));
    const bykey = vw();
    svg.dispatchEvent(new KeyboardEvent('keydown', { key: '0', bubbles: true, cancelable: true }));
    return { fit, zin, back, bykey, reset: vw(), focusable: svg.getAttribute('tabindex') === '0' };
  });
  // 右パネルで API を選ぶと、呼び出し元が図で分かるか
  const pick = await page.evaluate(() => {
    const svg = () => document.querySelector('#dg-svg');
    const g = [...svg().querySelectorAll('.dg-node')].find(
      (n) => (n.querySelector('.dg-sub') || {}).textContent && (n.querySelector('.dg-sub') || {}).textContent.includes('RPC'),
    );
    if (!g) return { skip: true };
    g.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const item = document.querySelector('#side .apipick-item');
    if (!item) return { noList: true };
    item.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const s = svg();
    const out = {
      callers: s.querySelectorAll('.dg-node.apicaller').length,
      target: s.querySelectorAll('.dg-node.apiimpl, .dg-node.apidef').length,
      dimmed: s.querySelectorAll('.dg-node.apidim').length,
      hit: s.querySelectorAll('.dg-edge.apihit').length,
      chip: !!document.querySelector('#dg-apiclear'),
    };
    document.querySelector('#dg-apiclear').click();
    out.clearedDim = document.querySelectorAll('#dg-svg .dg-node.apidim').length;
    out.clearedChip = !!document.querySelector('#dg-apiclear');
    return out;
  });
  if (pick.skip || pick.noList) {
    record('図: API を選ぶと呼び出し元が分かる', false, pick.skip ? 'RPC を持つ箱がない' : '右パネルに API 一覧がない');
  } else {
    record('図: API を選ぶと呼び出し元が分かる', pick.callers > 0 && pick.target > 0 && pick.dimmed > 0 && pick.hit > 0,
      `呼び出し元 ${pick.callers} / 対象 ${pick.target} / 減光 ${pick.dimmed} / 線 ${pick.hit}`);
    record('図: API の強調を解除できる', pick.chip && pick.clearedDim === 0 && !pick.clearedChip,
      `解除後 減光 ${pick.clearedDim} チップ ${pick.clearedChip}`);
  }

  record('図: ＋ボタンで拡大', zoom.zin < zoom.fit, `${zoom.fit} → ${zoom.zin}`);
  record('図: 全体を表示で戻る', zoom.back === zoom.fit, `${zoom.zin} → ${zoom.back}`);
  record('図: キーボードで拡大縮小', zoom.focusable && zoom.bykey < zoom.fit && zoom.reset === zoom.fit,
    `focusable=${zoom.focusable} + → ${zoom.bykey} / 0 → ${zoom.reset}`);
}

// ---------- エントリーポイント ----------
await page.click('#tab-entries');
await page.waitForTimeout(700);
const entryText = ((await text('#entriesview')) || '').trim();
record('エントリーポイント: 一覧', entryText !== '', entryText === '' ? '空' : '');

// ---------- 差分タブ ----------
await page.click('#tab-diff');
await page.waitForTimeout(1200);
const baseOpts = await page.$$eval('#diff-base option', (o) => o.length).catch(() => 0);
record('差分: ref 一覧の取得', baseOpts > 0, `${baseOpts} 件`);

// ---------- プロジェクトタブ ----------
await page.click('#tab-projects');
await page.waitForTimeout(700);
record('プロジェクト: 一覧描画', (await page.$$eval('.pcard', (c) => c.length)) > 0, '');

// 空欄で追加
await page.fill('#proj-path', '');
const errB = errors.length;
await page.click('#proj-add');
await page.waitForTimeout(900);
const emptyMsg = ((await text('#proj-msg')) || '').trim();
record('プロジェクト: 空欄で追加', emptyMsg !== '', emptyMsg === '' ? '無反応(メッセージも通信も無い)' : emptyMsg);

// 存在しないパスで追加
await page.fill('#proj-path', '/no/such/dir');
await page.click('#proj-add');
await page.waitForTimeout(1200);
const badMsg = ((await text('#proj-msg')) || '').trim();
record('プロジェクト: 不正パスで追加', badMsg.includes('見つかりません'), badMsg || '(メッセージ無し)');

// 複合プロジェクト: 不足入力
await page.fill('#comp-name', '');
await page.click('#comp-add');
await page.waitForTimeout(600);
const compMsg = ((await text('#comp-msg')) || '').trim();
record('複合: 入力不足の案内', compMsg !== '', compMsg || '(メッセージ無し)');

// 編集フォームの開閉
const editBtn = await page.$('[data-edit]');
if (editBtn) {
  await editBtn.click();
  await page.waitForTimeout(400);
  const open = await page.$$eval('.pedit', (f) => f.some((x) => !x.classList.contains('hidden')));
  record('プロジェクト: 編集フォーム', open, open ? '' : '開かない');
} else {
  record('プロジェクト: 編集フォーム', false, '[data-edit] が無い');
}

// ---------- 結果 ----------
console.log('\n=== 監査結果 ===');
for (const r of rows) console.log(`${r.ok ? '✓' : '✖'} ${r.name.padEnd(28)} ${r.detail}`);
console.log(`\n合計 ${rows.length} 件 / NG ${rows.filter((r) => !r.ok).length} 件`);
console.log('\n=== 収集した JS エラー ===');
console.log(errors.length ? [...new Set(errors)].join('\n') : 'なし');
await browser.close();
