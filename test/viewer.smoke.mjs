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
  addEventListener(type, fn) {
    if (!this.handlers.has(type)) this.handlers.set(type, []);
    this.handlers.get(type).push(fn);
  }
  fire(type, ev) { for (const fn of this.handlers.get(type) || []) fn(ev); }
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
globalThis.window = { STRATA_MODEL: model };
globalThis.document = {
  title: '',
  body: new El('body'),
  querySelector: (sel) => get(sel),
  addEventListener: () => {},
};

const src = fs.readFileSync(fileURLToPath(new URL('../web/app.js', import.meta.url)), 'utf8');
await eval(src);

const fail = (msg) => { console.error('✖ ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('✓ ' + msg);

// 1. 構造ビューが描画されている
const tree = get('#tree')._html;
if (tree.includes('gateway') && tree.includes('user-service')) ok('構造ビュー: ツリー描画');
else fail('構造ビュー: ツリーが空 / サービスがない');
if (get('#arcs')._html.includes('<path')) ok('構造ビュー: 円弧描画');
else fail('構造ビュー: 円弧なし');

// 1.2 検索フィルタ: 「テストを除外」チップで testsupport がツリーから消える
get('#btn-expand').fire('click'); // 全展開して深い階層も行に出す
if (get('#tree')._html.includes('testsupport')) ok('構造ビュー: testsupport が全展開で表示される');
else fail('testsupport がツリーにない');
get('#searchfilters').fire('click', {
  target: { closest: (sel) => (sel === '[data-sf]' ? { dataset: { sf: 'notest' }, classList: { toggle: () => {} } } : null) },
});
if (!get('#tree')._html.includes('testsupport')) ok('検索フィルタ: テストを除外で testsupport が消える');
else fail('テストを除外が効いていない');
// 解除して元に戻す
get('#searchfilters').fire('click', {
  target: { closest: (sel) => (sel === '[data-sf]' ? { dataset: { sf: 'notest' }, classList: { toggle: () => {} } } : null) },
});
if (get('#tree')._html.includes('testsupport')) ok('検索フィルタ: 解除で testsupport が戻る');
else fail('フィルタ解除が効いていない');
get('#btn-overview').fire('click'); // 以降のテストのため展開状態を元に戻す

// 1.5 サービス行クリック → マイクロサービス単位の依存サマリパネル
const rowClick = (id) =>
  get('#tree').fire('click', {
    target: { dataset: {}, closest: (sel) => (sel === '.row' ? { dataset: { id } } : null) },
  });
rowClick('svc:user-service');
const svcPanel = get('#side')._html;
if (svcPanel.includes('依存先サービス') && svcPanel.includes('依存元サービス'))
  ok('サービスパネル: 依存先/依存元の集計');
else fail('サービスパネルが出ない: ' + svcPanel.slice(0, 200));
if (svcPanel.includes('gateway') && svcPanel.includes('公開 API'))
  ok('サービスパネル: 依存元サービスと公開APIサマリ');
else fail('依存元/公開APIが想定外: ' + svcPanel.slice(0, 300));
rowClick('svc:user-service'); // 再クリックでフォーカス解除

// 2. API タブへ切り替え → カタログ描画
get('#tab-api').fire('click');
if (document.body.classes.has('tab-api')) ok('タブ切替: tab-api クラス付与');
else fail('タブ切替が効いていない');
const list = get('#apilist')._html;
for (const s of ['UserService', 'OrderService', 'GetUser', 'ListOrders', 'user.proto', 'order.proto']) {
  if (!list.includes(s)) fail(`カタログに ${s} がない`);
}
if (list.includes('6 RPC')) ok('カタログ: proto/service/RPC 集計 (' + (list.match(/\d+ proto ・ \d+ service ・ \d+ RPC/) || [''])[0] + ')');
else fail('カタログ集計が想定外: ' + list.slice(0, 200));
if (list.includes('deprecated') && list.includes('badge-stream')) ok('カタログ: deprecated / stream バッジ');
else fail('deprecated / stream バッジがない');
if (list.includes('テストのみ')) ok('カタログ: テストのみ RPC の検出(ListUsers)');
else fail('テストのみバッジがない');
if (list.includes('rpcdoc') && list.includes('1 件取得')) ok('カタログ: RPC の説明文表示');
else fail('説明文(rpcdoc)が表示されていない');
// フィルタの折りたたみ(sticky ヘッダ)
if (list.includes('apihead') && list.includes('data-ftoggle') && list.includes('class="filters"'))
  ok('カタログ: sticky ヘッダにフィルタ表示');
else fail('apihead / ftoggle がない');
get('#apilist').fire('click', { target: { closest: (s) => (s === '[data-ftoggle]' ? {} : null) } });
const collapsedFilters = get('#apilist')._html;
if (!collapsedFilters.includes('class="filters"') && collapsedFilters.includes('▸ フィルタ'))
  ok('カタログ: フィルタを畳める');
else fail('フィルタの折りたたみが効いていない');
get('#apilist').fire('click', { target: { closest: (s) => (s === '[data-ftoggle]' ? {} : null) } });
if (get('#apilist')._html.includes('class="filters"')) ok('カタログ: フィルタを再展開できる');
else fail('フィルタの再展開が効いていない');

// 3. RPC 選択 → フロー描画(サービス境界越え)
const rpcId = 'proto/user/v1/user.proto#UserService.GetUser';
get('#apilist').fire('click', {
  target: { closest: (sel) => (sel === '[data-rpc]' ? { dataset: { rpc: rpcId } } : null) },
});
const flow = get('#apiflow')._html;
if (flow.includes('UserService.GetUser')) ok('フロー: RPC ヘッダ');
else fail('フローに RPC 名がない');
for (const s of ['Server.GetUser', 'svcchip', 'user-service']) {
  if (!flow.includes(s)) fail(`フローに ${s} がない`);
}
ok('フロー: 実装ハンドラ + サービスチップ');
if (flow.includes('呼び出し元') && flow.includes('handleUser')) ok('フロー: 上流(gateway の呼び出し元)');
else fail('上流セクションに gateway の関数がない');
if (flow.includes('Server.ListOrders') || flow.includes('order-service')) ok('フロー: 上流にサービス横断(order→user)');
else console.log('  (注: order 側の上流表示は ' + (flow.includes('order') ? 'あり' : 'なし') + ')');
// フロー HTML に未文字列化オブジェクトや undefined 補間が混入していないこと
// (テンプレート生成の破損を検出。従来の常に真になるアサーションを置換)
if (typeof flow === 'string' && flow.length > 0 && !flow.includes('undefined') && !flow.includes('[object'))
  ok('フロー: 破損マーカー(undefined / [object Object])を含まない');
else fail('フロー出力が破損: ' + String(flow).slice(0, 160));

// 4. フロー内の関数クリック → ソースパネル(静的モードのメッセージ)
const funcId = 'services/user/internal/handler#Server.GetUser';
get('#apiflow').fire('click', {
  target: { closest: (sel) => (sel === '[data-flow]' ? { dataset: { flow: funcId } } : null) },
});
await new Promise((r) => setTimeout(r, 10));
const srcPanel = get('#apisrc')._html;
if (srcPanel.includes('handler.go') || srcPanel.includes('handler')) ok('ソースパネル: ファイル名表示');
else fail('ソースパネルが空: ' + srcPanel.slice(0, 120));
if (srcPanel.includes('エクスポートされた HTML')) ok('ソースパネル: 静的モードのフォールバック文言');

// 5. 検索(API タブ)
get('#search').fire('input', { target: { value: 'ListOrders' } });
await new Promise((r) => setTimeout(r, 300));
const filtered = get('#apilist')._html;
if (filtered.includes('ListOrders') && !filtered.includes('data-rpc="proto/user/v1/user.proto#UserService.GetUser"'))
  ok('検索: API カタログのフィルタ');
else fail('検索フィルタが効いていない');

// 6. フィルタ: 検索をリセットしてから状態チップ(未使用?)
get('#search').fire('input', { target: { value: '' } });
await new Promise((r) => setTimeout(r, 300));
const clickList = (sel, dataset) =>
  get('#apilist').fire('click', { target: { closest: (s) => (s === sel ? { dataset } : null) } });
clickList('[data-chip]', { chip: 'testonly' });
const testonlyList = get('#apilist')._html;
if (
  testonlyList.includes('表示中') &&
  testonlyList.includes('ListUsers') &&
  !testonlyList.includes('data-rpc="proto/user/v1/user.proto#UserService.GetUser"')
)
  ok('フィルタ: 「テストのみ」チップで絞り込み');
else fail('テストのみチップの絞り込みが効いていない');
// 3状態チップ: 含む → 除外 → 解除 なので、除外状態の検証を挟んで2回で解除する
clickList('[data-chip]', { chip: 'testonly' }); // → 除外
const excList = get('#apilist')._html;
if (!excList.includes('data-rpc="proto/user/v1/user.proto#UserService.ListUsers"') && excList.includes('GetUser'))
  ok('フィルタ: 「テストのみ」を除外(3状態チップ)');
else fail('テストのみの除外が効いていない');
clickList('[data-chip]', { chip: 'testonly' }); // → 解除

// 7. サービスフィルタ(検索つきコンボ)
const comboPick = (key, value) =>
  get('#apilist').fire('mousedown', {
    preventDefault() {},
    target: {
      closest: (sel) =>
        sel === '.combo-item'
          ? { dataset: { value }, closest: (s2) => (s2 === '.combo' ? { dataset: { combo: key } } : null) }
          : null,
    },
  });
comboPick('svc', 'OrderService');
const svcList = get('#apilist')._html;
if (svcList.includes('ListOrders') && !svcList.includes('data-rpc="proto/user/v1/user.proto#UserService.GetUser"'))
  ok('フィルタ: サービスのコンボ絞り込み');
else fail('サービス絞り込みが効いていない');
comboPick('svc', '');

// 8. 折りたたみ
clickList('[data-pfall]', { pfall: 'collapse' });
const collapsedList = get('#apilist')._html;
if (!collapsedList.includes('data-rpc=') && collapsedList.includes('▸')) ok('フィルタ: 全て畳む');
else fail('全て畳むが効いていない');
clickList('[data-pfall]', { pfall: 'expand' });
if (get('#apilist')._html.includes('data-rpc=')) ok('フィルタ: 全て開く');
else fail('全て開くが効いていない');

// 8.4 ナビゲーション履歴(ジャンプ → 戻る)
get('#tab-structure').fire('click');
rowClick('svc:gateway');
rowClick('svc:user-service');
get('#btn-back').fire('click');
const backPanel = get('#side')._html;
if (backPanel.includes('gateway')) ok('ナビ履歴: ← で前のフォーカスに戻る');
else fail('戻るが効かない: ' + backPanel.slice(0, 150));
get('#btn-fwd').fire('click');
if (get('#side')._html.includes('user-service')) ok('ナビ履歴: → で進む');
else fail('進むが効かない');
get('#btn-back').fire('click');
rowClick('svc:gateway'); // フォーカス解除(gateway が現在フォーカスなのでトグルで解除)

// 8.5 経路探索(gateway → user-service)
get('#tab-structure').fire('click');
rowClick('svc:gateway');
get('#side').fire('input', { target: { id: 'path-q', value: 'user-service' } });
get('#side').fire('keydown', { key: 'Enter', target: { id: 'path-q' } });
const candList = get('#side')._html;
if (candList.includes('data-path-target')) ok('経路探索: 候補一覧の表示');
else fail('経路候補が出ない: ' + candList.slice(0, 200));
get('#side').fire('click', {
  target: { closest: (sel) => (sel === '[data-path-target]' ? { dataset: { pathTarget: 'svc:user-service' } } : null) },
});
const pathPanel = get('#side')._html;
if (pathPanel.includes('経路 1') && (pathPanel.includes('GetUser') || pathPanel.includes('user')))
  ok('経路探索: gateway → user-service の経路列挙');
else fail('経路が出ない: ' + pathPanel.slice(0, 300));
if (pathPanel.includes('↓RPC') || pathPanel.includes('↓実装')) ok('経路探索: RPC/実装ホップの表示');
else fail('ホップ種別がない');
rowClick('svc:gateway'); // フォーカス解除

// 8.55 アーキテクチャ図タブ
get('#tab-diagram').fire('click');
const dgHtml = get('#diagramview')._html;
if (dgHtml.includes('dg-node') && dgHtml.includes('gateway') && dgHtml.includes('user-service'))
  ok('図タブ: サービスの箱の描画');
else fail('図タブが出ない: ' + dgHtml.slice(0, 200));
if (dgHtml.includes('dg-edge') && dgHtml.includes('層')) ok('図タブ: 依存エッジとレイヤー帯');
else fail('図のエッジ/帯がない');

// 8.56 図タブ内のナビゲーション(クリック移動 → ← で戻る)
get('#diagramview').fire('click', {
  target: { closest: (sel) => (sel === '[data-node]' ? { dataset: { node: 'svc:gateway' } } : null) },
});
if (get('#side')._html.includes('gateway')) ok('図タブ: 箱クリックで詳細パネル');
else fail('図の箱クリックが効かない');
get('#side').fire('click', {
  target: { closest: (sel) => (sel === '[data-id]' ? { dataset: { id: 'svc:user-service' } } : null) },
});
if (get('#side')._html.includes('user-service') && get('#diagramview')._html.includes('focused'))
  ok('図タブ: 依存先クリックで移動 + 図の強調');
else fail('図タブ内の移動が効かない');
get('#btn-back').fire('click');
if (get('#side')._html.includes('gateway') && document.body.classes.has('tab-diagram'))
  ok('図タブ: ← で図ビューのまま前のサービスに戻る');
else fail('図タブの戻るが効かない: tab-diagram=' + document.body.classes.has('tab-diagram'));
get('#btn-back').fire('click'); // フォーカスなし状態まで戻す

// 8.6 エントリーポイントタブ
get('#tab-entries').fire('click');
const entriesHtml = get('#entriesview')._html;
if (entriesHtml.includes('プロセス起動点') && entriesHtml.includes('main')) ok('エントリーポイントタブ: main 一覧');
else fail('エントリーポイントタブが出ない: ' + entriesHtml.slice(0, 200));
get('#tab-structure').fire('click');

// 9. スタックトレース解析
get('#btn-stack').fire('click');
get('#stack-input').value = `goroutine 1 [running]:
example.com/platform/services/user/internal/handler.(*Server).GetUser(0x0)
\t/app/services/user/internal/handler/handler.go:17 +0x1c
metrics.Count()`;
get('#stackmodal').fire('click', { target: { closest: (sel) => (sel === '#stack-parse' ? {} : null) } });
const sres = get('#stack-results')._html;
if (sres.includes('handler.go:17')) ok('スタックトレース: ファイル:行の解決');
else fail('スタックトレースのファイル解決失敗: ' + sres.slice(0, 200));
if (sres.includes('Count')) ok('スタックトレース: 関数名フォールバック解決');
else fail('関数名フォールバックが効かない');

console.log(process.exitCode ? '\nスモークテスト失敗あり' : '\nスモークテスト全件成功');
