// ビューア(web/app.js)の DOM スタブ・スモークテスト。
// ブラウザなしで描画ロジックとインタラクションを検証する。実行: npm test
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.ts';

const model = JSON.parse(
  JSON.stringify(scan(fileURLToPath(new URL('../examples/demo', import.meta.url)))),
);

class El {
  constructor(id) {
    this.id = id;
    this._html = '';
    this.attrs = {};
    this.style = {};
    this.dataset = {};
    this.classes = new Set();
    this.handlers = new Map();
    this.textContent = '';
    this.title = '';
  }
  set innerHTML(v) { this._html = v; }
  get innerHTML() { return this._html; }
  get classList() {
    const s = this.classes;
    return {
      add: (...c) => c.forEach((x) => s.add(x)),
      remove: (...c) => c.forEach((x) => s.delete(x)),
      toggle: (c, f) => { const on = f === undefined ? !s.has(c) : f; on ? s.add(c) : s.delete(c); return on; },
      contains: (c) => s.has(c),
    };
  }
  addEventListener(t, fn) { (this.handlers.get(t) ?? this.handlers.set(t, []).get(t)).push(fn); }
  fire(t, ev) { for (const fn of this.handlers.get(t) || []) fn(ev); }
  setAttribute(k, v) { this.attrs[k] = v; }
  querySelector() { return new El('(sub)'); }
  querySelectorAll() { return []; }
  scrollIntoView() {}
}

const registry = new Map();
const get = (sel) => {
  if (!registry.has(sel)) registry.set(sel, new El(sel));
  return registry.get(sel);
};
globalThis.window = {}; // STRATA_MODEL なし = serve モード
globalThis.fetch = async (url) => {
  if (url === 'model.json') return { ok: true, json: async () => model };
  if (String(url).startsWith('files')) return { ok: true, json: async () => ({ files: ['a/b.go', 'a/c.go', 'd.md'] }) };
  if (String(url).startsWith('source'))
    return {
      ok: true,
      json: async () => ({
        path: 'x',
        content: Array.from({ length: 15 }, (_, i) => `line${i + 1}`).join('\n'),
      }),
    };
  if (String(url).startsWith('blame')) {
    const sha = 'b'.repeat(40);
    return {
      ok: true,
      json: async () => ({
        lines: [1, 2, 3].map((line) => ({ sha, line, author: 'Alice', time: Math.floor(Date.now() / 1000) - 86400, summary: 'test commit' })),
      }),
    };
  }
  if (String(url).startsWith('commit')) {
    return {
      ok: true,
      json: async () => ({ sha: 'b'.repeat(40), author: 'Alice', time: 1700000000, subject: 'テスト変更 (#7)', pr: 7, repoUrl: 'https://github.com/x/y', patch: 'diff --git a/f b/f\n+added\n-removed' }),
    };
  }
  throw new Error('unexpected fetch: ' + url);
};
globalThis.document = {
  title: '',
  body: new El('body'),
  querySelector: (sel) => get(sel),
  addEventListener: () => {},
};

const src = fs.readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
await eval(src);
const tick = () => new Promise((r) => setTimeout(r, 20));

const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);
const apisrc = get('#apisrc');
const closestFor = (map) => ({ target: { closest: (sel) => map[sel] ?? null, id: '' } });

// RPC を開く → ソースパネルにコード + 📁ボタン
get('#tab-api').fire('click');
get('#apilist').fire('click', closestFor({ '[data-rpc]': { dataset: { rpc: 'proto/user/v1/user.proto#UserService.GetUser' } } }));
await tick();
if (apisrc._html.includes('treebtn') && apisrc._html.includes('line1')) ok('ソースパネル: コード + 📁ボタン');
else fail('ソースパネルが期待どおりでない: ' + apisrc._html.slice(0, 200));

// 📁 → ツリー表示(ルート: dir a + d.md)
apisrc.fire('click', closestFor({ '.treebtn': {} }));
await tick();
if (apisrc._html.includes('id="srctree"') && apisrc._html.includes('data-tree-dir="a"') && apisrc._html.includes('d.md'))
  ok('ツリー: ルート表示(dir + ファイル)');
else fail('ツリーが出ない: ' + apisrc._html.slice(0, 300));
if (!apisrc._html.includes('b.go')) ok('ツリー: 未展開 dir の中身は非表示');
else fail('折りたたみが効いていない');

// dir 展開 → b.go / c.go が見える
apisrc.fire('click', closestFor({ '[data-tree-dir]': { dataset: { treeDir: 'a' } } }));
await tick();
if (apisrc._html.includes('data-tree-file="a/b.go"') && apisrc._html.includes('data-tree-file="a/c.go"'))
  ok('ツリー: dir 展開');
else fail('dir 展開が効かない');

// ファイルクリック → そのファイルを開く(ヘッダーのファイル名が変わる)
apisrc.fire('click', closestFor({ '[data-tree-file]': { dataset: { treeFile: 'a/b.go' } } }));
await tick();
if (apisrc._html.includes('a/b.go') && apisrc._html.includes('class="titem file current"'.slice(0, 10)))
  ok('ツリー: ファイルを開く + current ハイライト');
else fail('ファイルを開けない: ' + apisrc._html.slice(0, 200));

// blame ガターとコミットモーダル
get('#apisrc').fire('click', { target: { closest: (sel) => (sel === '.blamebtn' ? {} : null) } });
await tick();
const blameHtml = get('#apisrc')._html;
if (blameHtml.includes('bbbbbbb') && blameHtml.includes('bl-new')) ok('git: blame ガターの表示(ブロック先頭チップ)');
else fail('blame ガターが出ない: ' + blameHtml.slice(0, 200));
get('#apisrc').fire('click', {
  target: { closest: (sel) => (sel === '[data-sha]' ? { dataset: { sha: 'b'.repeat(40) } } : null) },
});
await tick();
const gmHtml = get('#gitmodal-box')._html;
if (gmHtml.includes('テスト変更') && gmHtml.includes('/pull/7') && gmHtml.includes('dadd')) ok('git: コミットモーダル(PR リンク + 色付き diff)');
else fail('コミットモーダルが想定外: ' + gmHtml.slice(0, 300));

// 定義ホバープレビュー: 関数名トークンにホバー → 定義の file:line + コード断片
const tokEl = { textContent: 'GetUser', closest: null };
apisrc.fire('mouseover', {
  target: {
    closest: (sel) => (sel === '.tok-f' ? tokEl : sel === '.code' ? { id: 'code' } : null),
  },
  clientX: 100,
  clientY: 100,
});
await new Promise((r) => setTimeout(r, 350));
const peek = get('#defpeek');
if (!peek.classes.has('hidden') && peek._html.includes('GetUser') && peek._html.includes('user.proto'))
  ok('定義プレビュー: ホバーで file:line とヘッダを表示');
else fail('定義プレビューが出ない: hidden=' + peek.classes.has('hidden') + ' html=' + peek._html.slice(0, 200));
if (peek._html.includes('peekcode') && peek._html.includes('line9'))
  ok('定義プレビュー: コード断片を表示');
else fail('コード断片がない: ' + peek._html.slice(0, 300));

// ヘッダクリック → 定義ファイルへジャンプ(プレビューは閉じる)
peek.fire('click', {
  target: {
    closest: (sel) =>
      sel === '.peekhead' ? { dataset: { file: 'services/user/internal/handler/handler.go', line: '18' } } : null,
  },
});
await tick();
if (peek.classes.has('hidden') && apisrc._html.includes('handler.go'))
  ok('定義プレビュー: クリックで定義へジャンプ');
else fail('ジャンプが動かない');

console.log(process.exitCode ? '\nソースツリーテスト失敗あり' : '\nソースツリーテスト全件成功');
