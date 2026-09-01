// Strata ビューア(docs/SPEC.md §8)。外部ライブラリなしの素の JS。
(async function () {
  'use strict';

  // ?p=<パス> で表示するプロジェクト(リポジトリ)を切り替える
  const PROJ =
    typeof location !== 'undefined' ? new URLSearchParams(location.search).get('p') : null;
  const projQS = (sep) => (PROJ ? `${sep}p=${encodeURIComponent(PROJ)}` : '');
  // 起動オーバーレイ。model.json はリクエストのたびに解析するので数秒かかることがある。
  // 待ちが終わったら必ず外す — 外し損ねると不透明な板が画面全体を覆って何も操作できない
  const dropBoot = () => {
    if (typeof document.getElementById !== 'function') return;
    const boot = document.getElementById('boot');
    if (boot && boot.remove) boot.remove();
  };

  let model;
  if (window.STRATA_MODEL) {
    model = window.STRATA_MODEL;
  } else {
    try {
      const r = await fetch('model.json' + projQS('?'));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      model = await r.json();
    } catch (err) {
      dropBoot(); // 外さないと、この下で出す再試行の案内がオーバーレイに隠れる
      // 取得失敗を握りつぶすと画面が真っ白・無言になるため、原因と再試行導線を出す。
      const host = document.getElementById('layout') || document.body;
      host.textContent = '';
      const box = document.createElement('div');
      box.style.cssText =
        'padding:2rem;max-width:640px;margin:2rem auto;font-family:system-ui,sans-serif;line-height:1.7';
      const h = document.createElement('h2');
      h.textContent = 'モデルの読み込みに失敗しました';
      const p1 = document.createElement('p');
      p1.textContent =
        'model.json を取得できませんでした(' + (err && err.message ? err.message : String(err)) + ')。';
      const p2 = document.createElement('p');
      p2.textContent = 'サーバが起動しているか確認してから再読み込みしてください。';
      const btn = document.createElement('button');
      btn.textContent = '再読み込み';
      btn.style.cssText = 'padding:.4rem .9rem;cursor:pointer';
      btn.addEventListener('click', () => location.reload());
      box.append(h, p1, p2, btn);
      host.append(box);
      return;
    }
  }
  // モデルは手元にある。この先は同期処理なので、ここで外しておけば
  // 初期化中に例外が出ても画面が板で覆われたままにならない
  dropBoot();

  // ---------- 索引 ----------
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const childrenOf = new Map(); // 親キー('' = ルート) -> 子 id 配列
  for (const n of model.nodes) {
    const key = n.parent !== undefined && byId.has(n.parent) ? n.parent : '';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key).push(n.id);
  }
  const chainCache = new Map();
  function chain(id) {
    let c = chainCache.get(id);
    if (c) return c;
    const n = byId.get(id);
    c = n && n.parent !== undefined && byId.has(n.parent) ? [...chain(n.parent), id] : [id];
    chainCache.set(id, c);
    return c;
  }
  const depthOf = (id) => chain(id).length - 1;
  const parentOf = (id) => {
    const n = byId.get(id);
    return n && n.parent !== undefined && byId.has(n.parent) ? n.parent : null;
  };

  const subtreeLocCache = new Map();
  function subtreeLoc(id) {
    if (subtreeLocCache.has(id)) return subtreeLocCache.get(id);
    const n = byId.get(id);
    let total = (n && n.loc) || 0;
    for (const c of childrenOf.get(id) || []) total += subtreeLoc(c);
    subtreeLocCache.set(id, total);
    return total;
  }

  // 兄弟間エッジ: 親キー -> Map('a b' -> {from,to,count,kinds})
  // impl(RPC → 実装)はコールグラフ専用なので構造集約から除外する
  const sibEdges = new Map();
  for (const e of model.edges) {
    if (e.kind === 'impl') continue;
    const cu = chain(e.from);
    const cv = chain(e.to);
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    let i = 0;
    while (i < cu.length && i < cv.length && cu[i] === cv[i]) i++;
    if (i >= cu.length || i >= cv.length) continue;
    const parentKey = i === 0 ? '' : cu[i - 1];
    const a = cu[i];
    const b = cv[i];
    if (!sibEdges.has(parentKey)) sibEdges.set(parentKey, new Map());
    const bucket = sibEdges.get(parentKey);
    const key = a + ' ' + b;
    const cur = bucket.get(key);
    if (cur) {
      cur.count += e.count;
      cur.kinds.add(e.kind);
    } else {
      bucket.set(key, { from: a, to: b, count: e.count, kinds: new Set([e.kind]) });
    }
  }

  // ---------- Tarjan SCC(反復版) ----------
  function tarjan(ids, adj) {
    const index = new Map();
    const low = new Map();
    const onStack = new Set();
    const stack = [];
    const comps = [];
    let counter = 0;
    for (const start of ids) {
      if (index.has(start)) continue;
      const work = [{ node: start, ci: 0 }];
      while (work.length) {
        const frame = work[work.length - 1];
        const node = frame.node;
        if (frame.ci === 0) {
          index.set(node, counter);
          low.set(node, counter);
          counter++;
          stack.push(node);
          onStack.add(node);
        }
        const nbrs = adj.get(node) || [];
        let advanced = false;
        while (frame.ci < nbrs.length) {
          const next = nbrs[frame.ci++];
          if (!index.has(next)) {
            work.push({ node: next, ci: 0 });
            advanced = true;
            break;
          } else if (onStack.has(next)) {
            low.set(node, Math.min(low.get(node), index.get(next)));
          }
        }
        if (advanced) continue;
        if (low.get(node) === index.get(node)) {
          const comp = [];
          for (;;) {
            const p = stack.pop();
            onStack.delete(p);
            comp.push(p);
            if (p === node) break;
          }
          comps.push(comp);
        }
        work.pop();
        const pf = work[work.length - 1];
        if (pf) low.set(pf.node, Math.min(low.get(pf.node), low.get(node)));
      }
    }
    return comps;
  }

  // 循環グループ(統計・赤表示用)
  const cycleGroups = [];
  const cycleNodes = new Set();
  for (const [parentKey, bucket] of sibEdges) {
    const adj = new Map();
    const ids = new Set();
    for (const e of bucket.values()) {
      ids.add(e.from);
      ids.add(e.to);
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e.to);
    }
    for (const comp of tarjan([...ids], adj)) {
      if (comp.length < 2) continue;
      cycleGroups.push({ parent: parentKey, members: comp.sort() });
      for (const m of comp) cycleNodes.add(m);
    }
  }

  // ---------- 並び順(レベル化ソート §8.2) ----------
  const orderCache = new Map(); // parentKey + '|' + sort -> {order, level, hasLevels}
  function orderInfo(parentKey, sort) {
    const cacheKey = parentKey + '|' + sort;
    if (orderCache.has(cacheKey)) return orderCache.get(cacheKey);
    const kids = (childrenOf.get(parentKey) || []).slice();
    const labelOf = (id) => (byId.get(id) ? byId.get(id).label : id);
    let result;
    if (sort === 'alpha') {
      kids.sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
      result = { order: kids, level: null };
    } else if (sort === 'size') {
      kids.sort((a, b) => subtreeLoc(b) - subtreeLoc(a) || labelOf(a).localeCompare(labelOf(b)));
      result = { order: kids, level: null };
    } else {
      const bucket = sibEdges.get(parentKey) || new Map();
      const adj = new Map();
      for (const e of bucket.values()) {
        if (!adj.has(e.from)) adj.set(e.from, []);
        adj.get(e.from).push(e.to);
      }
      const comps = tarjan(kids, adj);
      const compOf = new Map();
      comps.forEach((comp, ci) => comp.forEach((id) => compOf.set(id, ci)));
      const compAdj = comps.map(() => new Set());
      for (const e of bucket.values()) {
        const ca = compOf.get(e.from);
        const cb = compOf.get(e.to);
        if (ca !== undefined && cb !== undefined && ca !== cb) compAdj[ca].add(cb);
      }
      const levels = new Array(comps.length).fill(-1);
      const levelOf = (ci) => {
        if (levels[ci] >= 0) return levels[ci];
        levels[ci] = 0; // 循環防止(縮約後は DAG のはずだが保険)
        let lvl = 0;
        for (const dep of compAdj[ci]) lvl = Math.max(lvl, levelOf(dep) + 1);
        levels[ci] = lvl;
        return lvl;
      };
      comps.forEach((_, ci) => levelOf(ci));
      const compsSorted = comps
        .map((comp, ci) => ({ comp: comp.slice().sort((a, b) => labelOf(a).localeCompare(labelOf(b))), lvl: levels[ci] }))
        .sort((a, b) => b.lvl - a.lvl || a.comp[0].localeCompare(b.comp[0]));
      const order = [];
      const level = new Map();
      for (const { comp, lvl } of compsSorted) {
        for (const id of comp) {
          order.push(id);
          level.set(id, lvl);
        }
      }
      result = { order, level };
    }
    orderCache.set(cacheKey, result);
    return result;
  }

  // ---------- コールグラフ(トレース §8.3) ----------
  const CALL_KINDS = new Set(['call', 'rpc', 'impl', 'http', 'graphql']);
  const callAdjDown = new Map();
  const callAdjUp = new Map();
  for (const e of model.edges) {
    if (!CALL_KINDS.has(e.kind)) continue;
    if (!callAdjDown.has(e.from)) callAdjDown.set(e.from, []);
    callAdjDown.get(e.from).push({ to: e.to, kind: e.kind, sites: e.sites });
    if (!callAdjUp.has(e.to)) callAdjUp.set(e.to, []);
    callAdjUp.get(e.to).push({ to: e.from, kind: e.kind, sites: e.sites });
  }
  // 木は分岐数の深さ乗で膨らむ。実測で分岐 3・深さ 12 が 240 万ノードになり、
  // そのまま DOM にすると固まる。総ノード数で頭を打たせて、打ち切りは … で示す
  const TRACE_MAX_NODES = 600;

  function traceTree(focusId, dir, maxDepth, opts = {}) {
    const adj = dir === 'up' ? callAdjUp : callAdjDown;
    let made = 0;
    const build = (id, path, depth, kind, sites) => {
      made++;
      if (path.has(id)) return { id, kind, sites, cycle: true, children: [] };
      if (depth > maxDepth || made > TRACE_MAX_NODES)
        return { id, kind, sites, cycle: false, children: [], truncated: true };
      path.add(id);
      // 兄弟は「親の中での呼び出し行順」に並べる(=コードを上から読む順)。
      // 呼び出し位置が無いエッジ(import 等)は後ろに名前順で置く
      // 同じ呼び出しが「パッケージ単位」と「関数単位」の 2 本で入ってくることがある
      // (RPC は呼び出し元パッケージにも関数にも線を張る)。粗いほうは情報を足さないうえ、
      // それ以上さかのぼれないので「そこで途切れた」ように見える。細かいほうがあれば落とす
      const kids = (adj.get(id) || []).slice();
      const coarse = new Set();
      if (opts.dedupeCoarse) {
        const kidIds = new Set(kids.map((k) => k.to));
        for (const k of kids) {
          let p = (byId.get(k.to) || {}).parent;
          for (let guard = 0; p !== undefined && guard < 100; guard++) {
            if (kidIds.has(p)) coarse.add(p);
            p = (byId.get(p) || {}).parent;
          }
        }
      }
      const children = kids
        .filter((k) => !(opts.dedupeCoarse && coarse.has(k.to)) && !(opts.skipMocks && isMockNode(k.to)))
        .sort((a, b) => {
          const la = a.sites && a.sites.length > 0 ? a.sites[0].l : Infinity;
          const lb = b.sites && b.sites.length > 0 ? b.sites[0].l : Infinity;
          if (la !== lb) return la - lb;
          return a.to < b.to ? -1 : 1;
        })
        .map((n) => build(n.to, path, depth + 1, n.kind, n.sites));
      path.delete(id);
      return { id, kind, sites, cycle: false, children };
    };
    return build(focusId, new Set(), 0);
  }
  // ---------- 経路探索(A → B がなぜ繋がっているか) ----------
  // 全エッジ種別(impl 含む)の隣接。経路には「RPC → 実装」のホップも含める
  const pathAdj = new Map();
  for (const e of model.edges) {
    if (!pathAdj.has(e.from)) pathAdj.set(e.from, []);
    pathAdj.get(e.from).push({ to: e.to, kind: e.kind, sites: e.sites });
  }
  function subtreeSet(rootId) {
    const set = new Set();
    const stack = [rootId];
    while (stack.length) {
      const id = stack.pop();
      set.add(id);
      for (const c of childrenOf.get(id) || []) stack.push(c);
    }
    return set;
  }
  /** A のサブツリーから B のサブツリーへの経路を最大 maxPaths 本探す。 */
  function findPaths(fromId, toId, maxPaths = 5) {
    const A = subtreeSet(fromId);
    const B = subtreeSet(toId);
    // ⊘ で非表示にした要素(とその配下)は経路として通らない
    const hidden = new Set();
    for (const h of state.structHidden) for (const id of subtreeSet(h)) hidden.add(id);
    // BFS で最短経路長を求める(マルチソース)
    const prev = new Map();
    let queue = [...A];
    for (const id of A) prev.set(id, null);
    let hit = null;
    while (queue.length && hit === null) {
      const next = [];
      for (const cur of queue) {
        for (const n of pathAdj.get(cur) || []) {
          if (hidden.has(n.to)) continue;
          if (prev.has(n.to)) continue;
          prev.set(n.to, cur);
          if (B.has(n.to)) {
            hit = n.to;
            break;
          }
          next.push(n.to);
        }
        if (hit !== null) break;
      }
      queue = next;
    }
    if (hit === null) return [];
    let shortestLen = 0;
    for (let cur = hit; prev.get(cur) !== null; cur = prev.get(cur)) shortestLen++;
    // 深さ制限つき DFS で複数経路を列挙(探索量に上限)
    const limit = Math.min(shortestLen + 2, 14);
    const results = [];
    let budget = 30000;
    const starts = [...A].filter((id) => (pathAdj.get(id) || []).some((n) => !A.has(n.to) || B.has(n.to)));
    const seenKeys = new Set();
    const dfs = (id, nodesPath, edgesPath) => {
      if (results.length >= maxPaths || budget-- <= 0) return;
      if (B.has(id) && edgesPath.length > 0) {
        const key = nodesPath.join('→');
        if (!seenKeys.has(key)) {
          seenKeys.add(key);
          results.push({ nodes: [...nodesPath], edges: [...edgesPath] });
        }
        return;
      }
      if (edgesPath.length >= limit) return;
      for (const n of pathAdj.get(id) || []) {
        if (hidden.has(n.to)) continue;
        if (nodesPath.includes(n.to)) continue;
        if (A.has(n.to) && !B.has(n.to)) continue; // A 内での迂回は探索しない
        nodesPath.push(n.to);
        edgesPath.push(n);
        dfs(n.to, nodesPath, edgesPath);
        nodesPath.pop();
        edgesPath.pop();
      }
    };
    for (const s of starts) {
      if (results.length >= maxPaths || budget <= 0) break;
      dfs(s, [s], []);
    }
    results.sort((a, b) => a.edges.length - b.edges.length);
    return results;
  }

  function reachSet(focusId, dir) {
    const adj = dir === 'up' ? callAdjUp : callAdjDown;
    const seen = new Set([focusId]);
    const queue = [focusId];
    while (queue.length) {
      const cur = queue.pop();
      for (const n of adj.get(cur) || []) {
        if (!seen.has(n.to)) {
          seen.add(n.to);
          queue.push(n.to);
        }
      }
    }
    return seen;
  }

  // ---------- 状態 ----------
  const state = {
    expanded: new Set(),
    sort: 'level',
    focus: null,
    q: '',
    violationsOnly: false,
    sideMode: null, // null | 'info' | 'cycles'
    traceDir: null, // null | 'down' | 'up'
    structSvc: '', // 構造ビュー: 表示するトップレベル('' = すべて)
    structHidden: new Set(), // 構造ビュー: 非表示にしたノード(サブツリーごと隠す)
    bookmarks: new Set(), // ブックマークしたノード(すぐ飛べる印。プロジェクト別に永続化)
    pathQuery: '', // 経路探索: 相手ノードの検索文字列
    pathTarget: null, // 経路探索: 相手ノード id
    structKinds: new Set(['import', 'call', 'boundary']), // 表示する依存線の種類
    dgIsolated: false, // 図: 孤立ノード(どこにも繋がらないもの)を展開するか
    dgApiOnly: false, // 図: 公開 API を持つものだけ表示するか
    dgHop: false, // 図: 選択ノードから 1 ホップだけ表示するか
    dgQ: '', // 図: 絞り込み文字列(一致しないものを減光する)
    dgApi: null, // 図: 右パネルで選んだ RPC。呼び出し元サービスを図で強調する
    tab: 'structure', // 'structure' | 'api'
    apiRpc: null, // API タブで選択中の RPC id
    apiSel: null, // フロー内で選択中のノード id(ソース表示対象)
    apiSvcFilter: '', // '' = 全サービス
    apiCallerFilter: '', // '' = すべて / '(test)' = テストから / サービス名
    apiSort: 'name', // 'name' | 'calls'
    // チップは3状態: undefined(解除)→ 'inc'(含む)→ 'exc'(除外)
    apiUsage: new Map(), // 使用状況: 'called' | 'testonly' | 'dead'(含むは OR、除外は常に適用)
    apiAttrs: new Map(), // 属性: 'noimpl' | 'deprecated' | 'stream'(同上。使用状況とは AND)
    apiExcludeTests: false, // テスト呼び出しを無視して本番コードだけで判定
    // 取り込んだ .proto には、このワークスペースが使わない RPC も全部入っている。
    // 既定では「呼ばれている / 実装されている」ものだけに絞る(チップで解除できる)
    apiUsedOnly: true,
    // mock(gomock 等の生成物・手書きのモック)を呼び出し元・実装から外す
    apiExcludeMocks: false,
    apiCollapsed: new Set(), // 折りたたまれた proto の id
    apiFilterCollapsed: false, // API カタログのフィルタを畳む(sticky ヘッダを小さく)
    searchExcludeTests: false, // 構造ビュー: テスト関連(testsupport / *_test 等)を表示から除外
    searchKinds: new Set(), // 構造ビュー検索の対象種別('func' | 'rpc' | 'file')。空 = すべて
  };
  const hasKids = (id) => (childrenOf.get(id) || []).length > 0;
  // 非表示リストの永続化(プロジェクトごと)
  const HIDDEN_KEY = 'strata.hidden.' + model.name;
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem(HIDDEN_KEY) || '[]');
      if (Array.isArray(saved)) state.structHidden = new Set(saved.filter((id) => byId.has(id)));
    }
  } catch {
    // 破損時は無視
  }
  // テスト関連ノードの判定(スキャン対象に残る testsupport / test-client 等を隠すため)
  const TEST_PATH_RE =
    /(^|\/)(tests?|__tests__|e2e|testsupport|test-client|testdata|mocks?)(\/|$)|_test\.(go|exs?)$|\.(test|spec)\.[jt]sx?$/i;
  function isTestNode(n) {
    if (!n) return false;
    return TEST_PATH_RE.test(n.id) || TEST_PATH_RE.test((n.meta && n.meta.file) || '');
  }

  // 検索フィルタの永続化(全プロジェクト共通)
  const SEARCH_FILTER_KEY = 'strata.searchFilters';
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem(SEARCH_FILTER_KEY) || '{}');
      state.searchExcludeTests = !!saved.excludeTests;
      if (Array.isArray(saved.kinds)) state.searchKinds = new Set(saved.kinds);
      state.apiFilterCollapsed = !!saved.apiFilterCollapsed;
    }
  } catch {
    // 破損時は無視
  }
  function persistSearchFilters() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(
          SEARCH_FILTER_KEY,
          JSON.stringify({
            excludeTests: state.searchExcludeTests,
            kinds: [...state.searchKinds],
            apiFilterCollapsed: state.apiFilterCollapsed,
          }),
        );
      }
    } catch {
      // 保存できなくても続行
    }
  }

  // 検索の対象種別フィルタ('func' = 関数、'rpc' = RPC、'file' = ファイル/proto)
  function searchKindOk(n) {
    if (state.searchKinds.size === 0) return true;
    const g =
      n.kind === 'func'
        ? 'func'
        : n.kind === 'rpc' || n.kind === 'route' || n.kind === 'gqlfield'
          ? 'rpc' // API 表面(gRPC / HTTP / GraphQL)をまとめて 1 グループにする
          : n.kind === 'file' || n.kind === 'proto'
            ? 'file'
            : 'other';
    return state.searchKinds.has(g);
  }

  // ブックマークの永続化(プロジェクトごと)
  const BOOKMARK_KEY = 'strata.bookmarks.' + model.name;
  try {
    if (typeof localStorage !== 'undefined') {
      const saved = JSON.parse(localStorage.getItem(BOOKMARK_KEY) || '[]');
      if (Array.isArray(saved)) state.bookmarks = new Set(saved.filter((id) => byId.has(id)));
    }
  } catch {
    // 破損時は無視
  }
  function persistBookmarks() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(BOOKMARK_KEY, JSON.stringify([...state.bookmarks]));
      }
    } catch {
      // 保存できなくても続行
    }
  }
  function toggleBookmark(id) {
    if (!id) return;
    if (state.bookmarks.has(id)) state.bookmarks.delete(id);
    else state.bookmarks.add(id);
    persistBookmarks();
    render();
  }

  function persistHidden() {
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(HIDDEN_KEY, JSON.stringify([...state.structHidden]));
      }
    } catch {
      // 保存できなくても続行
    }
  }
  function expandToDepth(maxDepth) {
    state.expanded = new Set();
    for (const n of model.nodes) {
      if (depthOf(n.id) <= maxDepth && hasKids(n.id)) state.expanded.add(n.id);
    }
  }
  expandToDepth(0);
  {
    // 表示行が少なすぎる場合はもう 1 段展開する
    const roots = childrenOf.get('') || [];
    let visible = roots.length;
    for (const r of roots) if (state.expanded.has(r)) visible += (childrenOf.get(r) || []).length;
    if (visible < 10) expandToDepth(1);
  }

  // ---------- DOM ----------
  const $ = (sel) => document.querySelector(sel);
  const treeEl = $('#tree');
  const arcsEl = $('#arcs');
  const sideEl = $('#side');
  const mainEl = $('#main');
  const KIND_ICON = {
    service: '◆', module: '▣', package: '□', dir: '▢',
    file: '·', proto: '⬡', func: 'ƒ', rpc: '⚡', topic: '✉',
    route: '⇄', gqlfield: '◈', artifact: '⬚',
  };
  const ROW = 24;
  const TREE_TOP = 8;
  document.title = 'Strata — ' + model.name;
  {
    // 凡例のソースリンクにバージョンを出す(モデルの tool は "strata 0.1.1" 形式)
    const ver = $('#srcver');
    const m = /^strata\s+(\S+)/.exec(String(model.tool || ''));
    if (ver && m) ver.textContent = 'v' + m[1];
  }
  $('#wsname').textContent = model.name;
  // ツリー行用のアイコンチップ(インラインテキスト用の KIND_ICON とは別)
  const KIND_CHIP = {
    service: 'S', module: 'M', package: 'P', dir: '·',
    file: '·', proto: '⬢', func: 'ƒ', rpc: '⚡', topic: '✉',
    route: 'H', gqlfield: 'G', artifact: '⬚',
  };
  if (model.warnings && model.warnings.length) {
    const badge = $('#warnbadge');
    badge.classList.remove('hidden');
    badge.title = model.warnings.join('\n');
  }

  function esc(s) {
    return String(s).replace(
      /[&<>"']/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
    );
  }

  // ---------- 描画 ----------
  let rows = [];
  let rowIndex = new Map();
  let hoverIndex = new Map(); // ノード id → 接続する arc 要素([{el, dir}])。render 時に構築
  const hoverState = { lastId: undefined, lastEls: [] }; // 直前ホバー(差分更新用)

  function computeRows() {
    rows = [];
    rowIndex = new Map();
    let traceKeep = null;
    if (state.traceDir && state.focus) {
      const reach = reachSet(state.focus, state.traceDir);
      traceKeep = new Set();
      for (const id of reach) for (const a of chain(id)) traceKeep.add(a);
      for (const id of reach) {
        // 到達ノードの祖先は強制展開
        for (const a of chain(id).slice(0, -1)) if (hasKids(a)) state.expanded.add(a);
      }
    }
    const matchSet = state.q ? new Set() : null;
    if (state.q) {
      const q = state.q.toLowerCase();
      for (const n of model.nodes) {
        if (state.searchExcludeTests && isTestNode(n)) continue;
        if (!searchKindOk(n)) continue;
        if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) {
          matchSet.add(n.id);
          for (const a of chain(n.id)) matchSet.add(a);
        }
      }
    }
    const walk = (parentKey, depth, band) => {
      const info = orderInfo(parentKey, state.sort);
      let prevLevel = null;
      for (const id of info.order) {
        if (depth === 0 && state.structSvc !== '' && id !== state.structSvc) continue;
        if (state.structHidden.has(id)) continue; // ⊘ で非表示にした要素(サブツリーごと)
        if (state.searchExcludeTests && isTestNode(byId.get(id))) continue; // テスト関連をサブツリーごと除外
        if (traceKeep && !traceKeep.has(id)) continue;
        const lvl = info.level ? info.level.get(id) : null;
        const levelBreak = depth === 0 && prevLevel !== null && lvl !== null && lvl !== prevLevel;
        const newLevel = depth === 0 && lvl !== null && lvl !== prevLevel;
        prevLevel = lvl;
        // 地層バンド: トップレベルのレベル値でバンドを塗り分け、配下の行にも引き継ぐ
        const rowBand = depth === 0 ? (lvl !== null ? lvl % 2 : 0) : band;
        rows.push({
          id, depth, levelBreak,
          dim: matchSet ? !matchSet.has(id) : false,
          band: rowBand,
          lvlTag: newLevel && state.sort === 'level' ? lvl : null,
        });
        rowIndex.set(id, rows.length - 1);
        if (state.expanded.has(id)) walk(id, depth + 1, rowBand);
      }
    };
    walk('', 0, 0);
  }

  function representative(id, displayed) {
    let cur = id;
    while (cur !== null && !displayed.has(cur)) cur = parentOf(cur);
    return cur;
  }

  function computeArcs() {
    const displayed = new Set(rows.map((r) => r.id));
    const repCache = new Map();
    const rep = (id) => {
      if (repCache.has(id)) return repCache.get(id);
      const r = representative(id, displayed);
      repCache.set(id, r);
      return r;
    };
    const traceReach = state.traceDir && state.focus ? reachSet(state.focus, state.traceDir) : null;
    const agg = new Map();
    for (const e of model.edges) {
      if (traceReach && !(CALL_KINDS.has(e.kind) && traceReach.has(e.from) && traceReach.has(e.to))) continue;
      if (!traceReach && e.kind === 'impl') continue; // 構造ビューでは impl を描かない
      // 線種フィルタ(import / call / サービス境界)
      const kindGroup = e.kind === 'import' ? 'import' : e.kind === 'call' ? 'call' : 'boundary';  // rpc/proto/impl/http/graphql/event = サービス境界
      if (!state.structKinds.has(kindGroup)) continue;
      const u = rep(e.from);
      const v = rep(e.to);
      if (!u || !v || u === v) continue;
      const iu = rowIndex.get(u);
      const iv = rowIndex.get(v);
      if (iu === undefined || iv === undefined) continue;
      const key = u + ' ' + v;
      const cur = agg.get(key);
      if (cur) {
        cur.count += e.count;
        cur.kinds.add(e.kind);
      } else {
        agg.set(key, { u, v, iu, iv, count: e.count, kinds: new Set([e.kind]) });
      }
    }
    return [...agg.values()];
  }

  function render() {
    computeRows();
    const arcs = computeArcs();

    // 寸法
    let maxText = 320;
    for (const r of rows) {
      const n = byId.get(r.id);
      const w = r.depth * 16 + (n ? n.label.length : 8) * 7.5 + 140;
      if (w > maxText) maxText = w;
    }
    const TW = Math.min(720, maxText);
    // メトロ配線スタイル: すべての接続線は左のレーンを通す(スパンが長いほど外側)
    const laneOf = (span) => Math.min(240, 16 + 9 * Math.sqrt(span));
    let maxLane = 28;
    for (const a of arcs) maxLane = Math.max(maxLane, laneOf(Math.abs(a.iu - a.iv)));
    const GL = Math.ceil(maxLane) + 16;
    const GR = 24;
    const totalH = rows.length * ROW + TREE_TOP * 2;
    const totalW = GL + TW + GR;

    // ツリー
    treeEl.style.left = GL + 'px';
    treeEl.style.width = TW + 'px';
    const parts = [];
    for (const r of rows) {
      const n = byId.get(r.id);
      if (!n) continue;
      const expanded = state.expanded.has(r.id);
      const tw = hasKids(r.id) ? (expanded ? '▾' : '▸') : '';
      const classes = ['row', 'k-' + n.kind, 'band' + r.band];
      if (cycleNodes.has(r.id)) classes.push('cyc');
      if (state.focus === r.id) classes.push('focused');
      if (r.dim) classes.push('dim');
      if (r.levelBreak) classes.push('lvlbrk');
      const loc = n.loc ? `<span class="loc">${n.loc}</span>` : '';
      const lvlTag = r.lvlTag !== null && r.lvlTag !== undefined ? `<span class="lvltag">層 ${r.lvlTag}</span>` : '';
      const icept =
        n.meta && n.meta.interceptors && n.meta.interceptors.length
          ? `<span class="icept" title="gRPC インターセプタ(全 RPC の前段で実行):\n${esc(n.meta.interceptors.join('\n'))}">🛡 ${n.meta.interceptors.length}</span>`
          : '';
      // 中継「候補」まで。実際の通信経路・層数は静的には決まらないので、そこは主張しない
      const relay =
        n.meta && n.meta.relayCandidate
          ? `<span class="relaychip" title="同じ RPC を実装しつつ自分でも呼んでいます(Gateway / Federation のような素通しの中継である可能性)。\n実際の通信経路や層数は静的解析では決まりません">中継候補</span>`
          : '';
      parts.push(
        `<div class="${classes.join(' ')}" data-id="${esc(r.id)}" style="padding-left:${r.depth * 16}px" title="${esc(r.id)}">` +
          `<span class="tw" data-tw="1">${tw}</span>` +
          `<span class="ic">${KIND_CHIP[n.kind] || '·'}</span>` +
          `<span class="lb">${esc(n.label)}</span>${lvlTag}${relay}${icept}${loc}` +
          `<span class="bmbtn${state.bookmarks.has(r.id) ? ' on' : ''}" data-bm="1" role="button" ` +
          `aria-label="ブックマーク" title="ブックマーク(b キーでも切替。ヘッダの ★ から一覧)">` +
          `${state.bookmarks.has(r.id) ? '★' : '☆'}</span>` +
          `<span class="hidebtn" data-hide="1" role="button" aria-label="この行を非表示にする" title="この行を非表示にする(ヘッダの「非表示 n」で戻す)">` +
          `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">` +
          `<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>` +
          `<line x1="1" y1="1" x2="23" y2="23"/></svg></span></div>`,
      );
    }
    treeEl.innerHTML = parts.join('');

    // 円弧
    arcsEl.setAttribute('width', totalW);
    arcsEl.setAttribute('height', totalH);
    arcsEl.style.width = totalW + 'px';
    arcsEl.style.height = totalH + 'px';
    const y = (i) => TREE_TOP + i * ROW + ROW / 2;
    // 矢じりマーカー(終端 = 依存先・呼び出し先に付く)。
    // markerUnits を userSpaceOnUse にして線の太さに関係なく一定サイズにする
    const marker = (id, cls) =>
      `<marker id="${id}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="11.5" markerHeight="11.5" markerUnits="userSpaceOnUse" orient="auto-start-reverse">` +
      `<path d="M0 1 L9 5 L0 9 z" class="${cls}"/></marker>`;
    const svgParts = [
      '<defs>' +
        marker('arr-down', 'mk-down') +
        marker('arr-up', 'mk-up') +
        marker('arr-out', 'mk-out') +
        marker('arr-in', 'mk-in') +
        marker('arr-accent', 'mk-accent') +
        '</defs>',
    ];
    let upCount = 0;
    arcs.sort((a, b) => Math.abs(b.iu - b.iv) - Math.abs(a.iu - a.iv));
    for (const a of arcs) {
      const up = a.iu > a.iv;
      if (up) upCount++;
      if (state.violationsOnly && !up) continue;
      const span = Math.abs(a.iu - a.iv);
      const b = laneOf(span);
      // 太さは依存数の対数。太くしすぎると配線が「土管」に見えて読めなくなるので上限は控えめに
      const width = Math.min(4.2, 1.3 + Math.log2(a.count + 1) * 0.62);
      const dashed = a.kinds.has('rpc') || a.kinds.has('proto') || a.kinds.has('impl') || a.kinds.has('http') || a.kinds.has('graphql');
      const classes = [];
      if (up) classes.push('up');
      if (dashed) classes.push('dashed');
      if (state.focus) {
        if (a.u === state.focus) classes.push('out', 'flow');
        else if (a.v === state.focus) classes.push('in', 'flow');
        else classes.push('faded');
      }
      // トレース表示中は経路全体を「流れる破線」で向きを見せる
      if (state.traceDir && state.focus && !classes.includes('faded')) {
        if (!classes.includes('flow')) classes.push('flow');
      }
      // 直交配線: 呼び出し元の行から左へ → 縦レーン → 依存先の行へ矢印で入る
      const x0 = GL - 2;
      const laneX = GL - b;
      const yu = y(a.iu);
      const yv = y(a.iv);
      const dir = yv > yu ? 1 : -1;
      const r = Math.min(8, Math.abs(yv - yu) / 2, x0 - laneX);
      const d =
        `M ${x0} ${yu} H ${laneX + r} Q ${laneX} ${yu} ${laneX} ${yu + dir * r} ` +
        `V ${yv - dir * r} Q ${laneX} ${yv} ${laneX + r} ${yv} H ${x0}`;
      const fromLabel = byId.get(a.u) ? byId.get(a.u).label : a.u;
      const toLabel = byId.get(a.v) ? byId.get(a.v).label : a.v;
      const kinds = [...a.kinds].join(',');
      svgParts.push(
        `<path d="${d}" stroke-width="${width.toFixed(1)}" class="${classes.join(' ')}" data-u="${esc(a.u)}" data-v="${esc(a.v)}">` +
          `<title>${esc(fromLabel)} → ${esc(toLabel)}  (${a.count} deps, ${esc(kinds)})</title></path>` +
          // 始点ドット(依存元の印。矢じり側が依存先)
          `<circle class="dot ${classes.join(' ')}" cx="${x0}" cy="${yu}" r="${Math.min(3.2, 1.6 + width * 0.4).toFixed(1)}" data-u="${esc(a.u)}" data-v="${esc(a.v)}"/>`,
      );
    }
    arcsEl.innerHTML = svgParts.join('');
    // 「レイヤー違反のみ」で 1 本も無いときは、線が消えた理由を明示する
    {
      const note = $('#vio-empty');
      if (note && note.classList) note.classList.toggle('hidden', !(state.violationsOnly && upCount === 0));
    }
    // ホバー高速化: ノード id → 接続要素(out/in)の索引をレンダごとに 1 回だけ作る。
    // これで applyRowHover が毎回全 path/circle を走査せずに済む。
    hoverIndex = new Map();
    hoverState.lastId = undefined;
    hoverState.lastEls = [];
    for (const el of arcsEl.querySelectorAll('path, circle.dot')) {
      const u = el.dataset.u;
      const v = el.dataset.v;
      if (u) (hoverIndex.get(u) || hoverIndex.set(u, []).get(u)).push({ el, dir: 'out' });
      if (v && v !== u) (hoverIndex.get(v) || hoverIndex.set(v, []).get(v)).push({ el, dir: 'in' });
    }

    // 統計
    const statsEl = $('#stats');
    const hiddenBadge =
      state.structHidden.size > 0
        ? ` ・ <b class="hid-badge" title="クリックで非表示をすべて解除">非表示 ${state.structHidden.size}</b>`
        : '';
    const bmBadge =
      state.bookmarks.size > 0
        ? ` ・ <b class="bm-badge" title="クリックでブックマーク一覧">★ ${state.bookmarks.size}</b>`
        : '';
    statsEl.title =
      'nodes = グラフに載っているノード数 / deps = 依存の本数 / ' +
      '循環 = 互いに依存し合っているグループ数 / 上向き = レイヤー違反の線の本数\n' +
      '「循環」をクリックすると一覧、「上向き」は違反の線だけを絞り込めます';
    // 検索は非一致を減光する方式なので、行数が変わらない。
    // 一致件数を出さないと、0 件のときに「検索が効いていない」ように見える
    const hitBadge = state.q
      ? rows.filter((r) => !r.dim).length === 0
        ? ` ・ <b class="hit-badge none" title="この検索語に一致するノードはありません">「${esc(state.q)}」に一致なし</b>`
        : ` ・ <b class="hit-badge" title="一致した行を強調し、それ以外を減光しています">一致 ${rows.filter((r) => !r.dim).length}</b>`
      : '';
    statsEl.innerHTML =
      `${model.nodes.length} nodes ・ ${model.edges.length} deps ・ ` +
      `<b class="cyc-badge" title="クリックすると循環しているノードの一覧を表示します">循環 ${cycleGroups.length}</b> ・ ` +
      `<b class="up-badge" title="レイヤー違反(下の層 → 上の層)の線の本数。ツールバーの「⚠ レイヤー違反のみ」で絞り込めます">上向き ${upCount}</b>` +
      hitBadge +
      bmBadge +
      hiddenBadge;
    statsEl.querySelector('.cyc-badge').addEventListener('click', () => {
      state.sideMode = state.sideMode === 'cycles' ? null : 'cycles';
      renderSide();
    });
    const hidBadge = statsEl.querySelector('.hid-badge');
    if (hidBadge)
      hidBadge.addEventListener('click', () => {
        state.structHidden = new Set();
        persistHidden();
        render();
        if (state.tab === 'diagram') renderDiagram(); // バッジは図タブでも押せる
      });
    const bmBadgeEl = statsEl.querySelector('.bm-badge');
    if (bmBadgeEl)
      bmBadgeEl.addEventListener('click', () => {
        state.sideMode = state.sideMode === 'bookmarks' ? null : 'bookmarks';
        renderSide();
      });

    renderSide();
  }

  // ---------- サイドパネル ----------
  function fileLink(n) {
    const meta = n.meta || {};
    if (!meta.file) return '';
    const lineNo = meta.line || 1;
    if (IS_STATIC) {
      // エクスポート HTML にはサーバーが無いので vscode:// スキームに頼る
      const href = 'vscode://file' + encodeURI(model.root + '/' + meta.file) + ':' + lineNo;
      return `<a href="${href}">${esc(meta.file)}:${lineNo}</a>`;
    }
    return `<a href="#" class="editorlink" data-open-file="${esc(meta.file)}" data-open-line="${lineNo}" title="ローカルのエディタで開く">${esc(meta.file)}:${lineNo}</a>`;
  }
  // エディタ起動はサーバー(/open)経由。vscode:// を扱えないブラウザでも動く
  document.addEventListener('click', (ev) => {
    const link = ev.target && ev.target.closest && ev.target.closest('[data-open-file]');
    if (!link) return;
    ev.preventDefault();
    fetch(
      'open?f=' +
        encodeURIComponent(link.dataset.openFile) +
        '&l=' +
        encodeURIComponent(link.dataset.openLine || '') +
        projQS('&'),
    )
      .then((r) => r.json())
      .then((j) => {
        if (j && j.error) console.warn('エディタ起動に失敗:', j.error);
      })
      .catch(() => {});
  });

  function renderTraceNode(node, parentTopId, isRoot) {
    const n = byId.get(node.id);
    const top = chain(node.id)[0];
    const boundary =
      parentTopId !== undefined && top !== parentTopId
        ? ` <span class="boundary">← ${esc(byId.get(top) ? byId.get(top).label : top)}</span>`
        : '';
    const cyc = node.cycle ? ' <span class="cycmark">↻ 循環</span>' : '';
    const trunc = node.truncated ? ' <span class="loc">…</span>' : '';
    const meta = (n && n.meta) || {};
    const loc = meta.file ? ` <span class="loc">${esc(meta.file)}${meta.line ? ':' + meta.line : ''}</span>` : '';
    const icon = n ? KIND_ICON[n.kind] || '·' : '·';
    const kids = node.children.map((c) => renderTraceNode(c, top, false)).join('');
    return (
      `<div class="tnode${isRoot ? ' root' : ''}">` +
      `<span class="tlabel" data-id="${esc(node.id)}">${icon} ${esc(n ? n.label : node.id)}${loc}${boundary}${cyc}${trunc}</span>` +
      kids +
      `</div>`
    );
  }

  // 経路探索セクション(サイドパネル共通)
  function buildPathSection(n) {
    let html =
      `<div class="sec">経路探索(このノードから)</div>` +
      `<div class="pathrow"><input id="path-q" type="text" placeholder="相手ノード名で検索して Enter…" value="${esc(state.pathQuery)}">` +
      (state.pathTarget ? `<button id="path-clear">解除</button>` : '') +
      `</div>`;
    if (state.pathTarget && byId.has(state.pathTarget)) {
      const tgt = byId.get(state.pathTarget);
      const paths = findPaths(n.id, state.pathTarget, 5);
      html += `<div class="sub">→ ${esc(tgt.label)} への経路: ${paths.length === 0 ? 'なし(相手側を選択して逆向きも確認を)' : paths.length + ' 本'}</div>`;
      paths.forEach((path, i) => {
        const parts = [`<div class="sub pathsub">経路 ${i + 1}(${path.edges.length} ホップ)</div><div class="pathchain">`];
        let prevTop;
        path.nodes.forEach((id, idx) => {
          const node = byId.get(id) || { label: id, kind: 'file' };
          const top = chain(id)[0];
          const chip =
            prevTop !== undefined && top !== prevTop
              ? ` <span class="svcbadge">${esc((byId.get(top) || {}).label || top)}</span>`
              : '';
          prevTop = top;
          const edge = idx > 0 ? path.edges[idx - 1] : null;
          const kindLbl = edge
            ? `<span class="parrow">${edge.kind === 'impl' ? '↓実装' : edge.kind === 'rpc' || edge.kind === 'proto' ? '↓RPC' : '↓'}</span>`
            : '';
          const site = edge && edge.sites && edge.sites.length > 0 ? edge.sites[0] : null;
          const siteChip = site
            ? ` <span class="fsite" data-srcfile="${esc(site.f)}" data-srcline="${site.l}" title="呼び出し箇所を開く">呼出 ${esc(site.f.slice(site.f.lastIndexOf('/') + 1))}:${site.l}</span>`
            : '';
          if (kindLbl) parts.push(`<div class="pathkind">${kindLbl}</div>`);
          parts.push(
            `<div class="pathnode"><span data-id="${esc(id)}" class="plabel">${KIND_ICON[node.kind] || '·'} ${esc(node.label)}</span>${chip}${siteChip}</div>`,
          );
        });
        parts.push('</div>');
        html += parts.join('');
      });
    } else if (state.pathQuery.trim() !== '') {
      const q = state.pathQuery.trim().toLowerCase();
      const cands = model.nodes
        .filter((x) => x.id !== n.id && (x.label.toLowerCase().includes(q) || x.id.toLowerCase().includes(q)))
        .slice(0, 15);
      html +=
        `<ul>` +
        cands
          .map((x) => {
            const top = chain(x.id)[0];
            const topLbl = top === x.id ? '' : (byId.get(top) || {}).label || '';
            return `<li data-path-target="${esc(x.id)}">${KIND_ICON[x.kind] || '·'} ${esc(x.label)}<span class="cnt">${esc(topLbl)}</span></li>`;
          })
          .join('') +
        `</ul>` +
        (cands.length === 0 ? '<div class="sub">一致するノードがありません</div>' : '');
    }
    return html;
  }

  function renderSide() {
    if (state.sideMode === null) {
      sideEl.classList.add('hidden');
      return;
    }
    sideEl.classList.remove('hidden');
    if (state.sideMode === 'cycles') {
      const items = cycleGroups
        .map((g, i) => {
          const where = g.parent === '' ? '(トップレベル)' : esc(byId.get(g.parent) ? byId.get(g.parent).id : g.parent);
          const members = g.members
            .map((m) => `<li data-id="${esc(m)}">${KIND_ICON[(byId.get(m) || {}).kind] || '·'} ${esc(byId.get(m) ? byId.get(m).label : m)}</li>`)
            .join('');
          return `<div class="sec">循環 ${i + 1} — ${where}</div><ul>${members}</ul>`;
        })
        .join('');
      sideEl.innerHTML =
        `<h3>循環依存 (${cycleGroups.length})</h3>` +
        (cycleGroups.length === 0 ? '<div class="sub">検出されませんでした 🎉</div>' : items);
      return;
    }
    if (state.sideMode === 'bookmarks') {
      const ids = [...state.bookmarks].filter((id) => byId.has(id));
      const items = ids
        .map((id) => {
          const node = byId.get(id);
          return (
            `<li data-id="${esc(id)}" title="${esc(id)}">${KIND_ICON[(node || {}).kind] || '·'} ` +
            `${esc(node ? node.label : id)}<span class="bm-remove" data-bm-remove="${esc(id)}" title="ブックマーク解除">✕</span></li>`
          );
        })
        .join('');
      sideEl.innerHTML =
        `<h3>★ ブックマーク (${ids.length})</h3>` +
        (ids.length === 0
          ? '<div class="sub">行の ☆ か b キーで登録します。クリックでその場所へ飛べます</div>'
          : `<ul>${items}</ul><div class="btns"><button id="btn-bm-clear">すべて解除</button></div>`);
      const clearBtn = sideEl.querySelector('#btn-bm-clear');
      if (clearBtn)
        clearBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.bookmarks = new Set();
          persistBookmarks();
          render();
        });
      return;
    }
    // info モード
    const n = state.focus ? byId.get(state.focus) : null;
    if (!n) {
      sideEl.innerHTML = '<div class="sub">ノードをクリックすると詳細とトレースを表示します</div>';
      return;
    }
    const topLabelOf = (id) => {
      const top = chain(id)[0];
      const tn = byId.get(top);
      return tn ? tn.label : top;
    };
    const locOf = (node) => {
      const meta = (node && node.meta) || {};
      return meta.file ? `<span class="loc">${esc(meta.file)}${meta.line ? ':' + meta.line : ''}</span>` : '';
    };

    // ⚡RPC 選択時: 呼び出し元サービス・実装・下流フローを一望できる専用パネル
    if (n.kind === 'rpc') {
      const callerIds = [...new Set(model.edges.filter((e) => e.kind === 'rpc' && e.to === n.id).map((e) => e.from))];
      const implIds = [...new Set(model.edges.filter((e) => e.kind === 'impl' && e.from === n.id).map((e) => e.to))];
      const item = (id) => {
        const node = byId.get(id);
        return (
          `<li data-id="${esc(id)}"><span class="svcbadge">${esc(topLabelOf(id))}</span>` +
          ` ƒ ${esc(node ? node.label : id)} ${locOf(node)}</li>`
        );
      };
      const tree = traceTree(n.id, 'down', 8);
      sideEl.innerHTML =
        `<h3>⚡ ${esc(n.label)}</h3>` +
        `<div class="sub">${esc(n.id)}<br>${fileLink(n)}</div>` +
        `<div class="btns"><button id="btn-open-api">⚡ API フローで開く</button></div>` +
        `<div class="sec">呼び出し元(クライアント) (${callerIds.length})</div>` +
        `<ul>${callerIds.map(item).join('') || '<li class="sub">検出なし(未対応言語からの呼び出しは表示されません)</li>'}</ul>` +
        `<div class="sec">実装(サーバハンドラ) (${implIds.length})</div>` +
        `<ul>${implIds.map(item).join('') || '<li class="sub">未検出</li>'}</ul>` +
        `<div class="sec">呼び出しフロー(実装の下流)</div>` +
        `<div class="tracetree">${renderTraceNode(tree, undefined, true)}</div>`;
      const openApiBtn = sideEl.querySelector('#btn-open-api');
      if (openApiBtn)
        openApiBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.apiRpc = n.id;
          setTab('api');
        });
      return;
    }

    // ⬡proto 選択時: RPC 一覧(呼び出し数・実装サービス付き)
    if (n.kind === 'proto') {
      const rpcKids = (childrenOf.get(n.id) || []).filter((id) => (byId.get(id) || {}).kind === 'rpc');
      const rows = rpcKids.map((id) => {
        const callers = new Set(model.edges.filter((e) => e.kind === 'rpc' && e.to === id).map((e) => e.from));
        const impls = model.edges.filter((e) => e.kind === 'impl' && e.from === id);
        const implSvc = impls.length > 0 ? topLabelOf(impls[0].to) : null;
        return (
          `<li data-id="${esc(id)}">⚡ ${esc(byId.get(id).label)}` +
          `<span class="cnt">${callers.size} 呼び出し${implSvc ? ' ・ 実装: ' + esc(implSvc) : ''}</span></li>`
        );
      });
      const services = n.meta && n.meta.services ? n.meta.services.join(', ') : '';
      sideEl.innerHTML =
        `<h3>⬡ ${esc(n.label)}</h3>` +
        `<div class="sub">${esc(n.id)}<br>${services ? 'service: ' + esc(services) + ' ' : ''}${fileLink(n)}</div>` +
        `<div class="sec">RPC 一覧 (${rows.length})</div>` +
        `<ul>${rows.join('') || '<li class="sub">RPC なし</li>'}</ul>` +
        `<div class="sub" style="margin-top:8px">RPC をクリックすると呼び出し元サービスと関数レベルのフローを表示します</div>`;
      return;
    }
    // ◆サービス/モジュール(トップレベル)選択時: マイクロサービス単位の依存サマリ
    if (depthOf(n.id) === 0) {
      // 生エッジをトップレベルに集約(画面の展開状態に依存しない)。
      // 共有 proto/ ディレクトリ構成では RPC ノードが proto 側にぶら下がるため、
      // RPC への依存は「そのRPCを実装しているサービス」に付け替えて集計する
      const implTopOf = (rpcId) => {
        const impls = rpcImpls.get(rpcId);
        return impls && impls.size > 0 ? chain([...impls][0])[0] : null;
      };
      const svcTopOfTarget = (toId) => {
        const toNode = byId.get(toId);
        if (toNode && toNode.kind === 'rpc') {
          const t = implTopOf(toId);
          if (t) return t;
        } else if (toNode && toNode.kind === 'proto') {
          for (const kid of childrenOf.get(toId) || []) {
            const t = implTopOf(kid);
            if (t) return t;
          }
        }
        return chain(toId)[0];
      };
      const outMap = new Map(); // topId -> {count, rpc, code, items:[{from,to,count,isRpc}]}
      const inMap = new Map();
      for (const e of model.edges) {
        if (e.kind === 'impl') continue;
        const tu = chain(e.from)[0];
        const tv = svcTopOfTarget(e.to);
        if (tu === tv || (tu !== n.id && tv !== n.id)) continue;
        const isRpc = e.kind === 'rpc' || e.kind === 'proto' || e.kind === 'http' || e.kind === 'graphql';
        const bump = (map, key) => {
          const cur = map.get(key) || { count: 0, rpc: 0, code: 0, items: [] };
          cur.count += e.count;
          if (isRpc) cur.rpc += e.count;
          else cur.code += e.count;
          cur.items.push({ from: e.from, to: e.to, count: e.count, isRpc });
          map.set(key, cur);
        };
        if (tu === n.id) bump(outMap, tv);
        if (tv === n.id) bump(inMap, tu);
      }
      const DRILL_CAP = 30; // 1 サービスあたりの関数レベル表示上限
      const API_PICK_CAP = 60; // 図で追う API 一覧の表示上限(それ以上はカタログ側で探す)
      // 関数レベルの内訳(呼び出し元関数 → 呼び出し先 RPC/関数)。クリックで該当ノードへ。
      const drillList = (d) => {
        const items = d.items.slice().sort((a, b) => b.count - a.count);
        const shown = items.slice(0, DRILL_CAP);
        const rows = shown
          .map((it) => {
            const fromN = byId.get(it.from);
            const toN = byId.get(it.to);
            const cnt = it.count > 1 ? `<span class="cnt">×${it.count}</span>` : '';
            return (
              `<li><span class="fn" data-id="${esc(it.from)}" title="${esc(it.from)}">${esc(fromN ? fromN.label : it.from)}</span>` +
              `<span class="darrow">${it.isRpc ? '⚡' : '→'}</span>` +
              `<span class="fn" data-id="${esc(it.to)}" title="${esc(it.to)}">${esc(toN ? toN.label : it.to)}</span>${cnt}</li>`
            );
          })
          .join('');
        const more = items.length > DRILL_CAP ? `<li class="sub">…他 ${items.length - DRILL_CAP} 件</li>` : '';
        return `<ul class="drill">${rows}${more}</ul>`;
      };
      const svcItem = ([id, d]) => {
        const node = byId.get(id);
        const detail =
          (d.rpc > 0 ? `⚡${d.rpc}` : '') + (d.rpc > 0 && d.code > 0 ? ' ・ ' : '') + (d.code > 0 ? `code ${d.code}` : '');
        // details で関数レベルの内訳を折りたたむ(summary クリックで開閉)。
        // 個々の関数はクリックで該当ノードへ移動できる。
        return (
          `<details class="svcdrill"><summary>${KIND_ICON[(node || {}).kind] || '·'} ` +
          `${esc(node ? node.label : id)}<span class="cnt">${detail}</span></summary>${drillList(d)}</details>`
        );
      };
      const sorted = (map) => [...map].sort((a, b) => b[1].count - a[1].count);
      // このサービスが公開する RPC の使用状況
      let rpcTotal = 0;
      let called = 0;
      let testOnly = 0;
      const protoSvcNames = new Set();
      const ownRpcs = []; // 図タブで「どこから呼ばれているか」を選ぶための一覧
      for (const nn of model.nodes) {
        if (nn.kind !== 'rpc') continue;
        const owner = implTopOf(nn.id) || chain(nn.id)[0]; // 実装サービス優先で帰属
        if (owner !== n.id) continue;
        rpcTotal++;
        if (nn.label.includes('.')) protoSvcNames.add(nn.label.slice(0, nn.label.indexOf('.')));
        const callerTops = new Set([...(rpcCallers.get(nn.id) || [])].map((c) => chain(c)[0]));
        if ((rpcCallers.get(nn.id) || new Set()).size > 0) called++;
        else if (((nn.meta || {}).testCallers || 0) > 0) testOnly++;
        ownRpcs.push({ id: nn.id, label: nn.label, callers: callerTops.size });
      }
      // 呼ばれている数の多い順。図で追いたいのはたいてい呼び出し元の多い API
      ownRpcs.sort((a, b) => b.callers - a.callers || a.label.localeCompare(b.label));
      const dead = rpcTotal - called - testOnly;
      const apiSum =
        rpcTotal > 0
          ? `<div class="sec">公開 API(RPC ${rpcTotal})</div>` +
            `<ul><li class="nostyle">本番から呼ばれる<span class="cnt">${called}</span></li>` +
            `<li class="nostyle">テストのみ<span class="cnt">${testOnly}</span></li>` +
            `<li class="nostyle">未使用<span class="cnt">${dead}</span></li></ul>` +
            // 図タブでは API を選んで「どのサービスから呼ばれているか」を図の上で見られるようにする
            (state.tab === 'diagram'
              ? `<div class="sub">選ぶと、その API を呼んでいるサービスを図で強調します</div>` +
                `<ul class="apipick">` +
                ownRpcs
                  .slice(0, API_PICK_CAP)
                  .map(
                    (r) =>
                      `<li class="apipick-item${state.dgApi === r.id ? ' on' : ''}" data-dgapi="${esc(r.id)}" ` +
                      `title="${esc(r.id)}">⚡ ${esc(r.label)}` +
                      `<span class="cnt">${r.callers > 0 ? r.callers + ' サービスから' : '呼び出し元なし'}</span></li>`,
                  )
                  .join('') +
                (ownRpcs.length > API_PICK_CAP
                  ? `<li class="sub">…他 ${ownRpcs.length - API_PICK_CAP} 件は API カタログで</li>`
                  : '') +
                `</ul>`
              : '') +
            `<div class="btns"><button id="btn-svc-api">⚡ API カタログで見る</button></div>`
          : '';
      const isolated =
        outMap.size === 0 && inMap.size === 0
          ? `<div class="sub">⚠ 他のサービスとの静的な依存が見つかりません` +
            (rpcTotal > 0 && called === 0 ? '(このサービスの RPC を呼ぶ本番コードがありません)' : '') +
            `。メッセージキュー等の動的連携は検出対象外です</div>`
          : '';
      const meta = n.meta || {};
      const listSec = (title, arr) =>
        arr && arr.length
          ? `<div class="sec">${title} (${arr.length})</div><ul>` +
            arr.map((v) => `<li class="nostyle">${esc(v)}</li>`).join('') +
            '</ul>'
          : '';
      const relaySum = meta.relayCandidate
        ? '<div class="sec">中継候補</div><ul><li class="nostyle">同じ RPC を実装しつつ自分でも呼んでいます。' +
          '実際にどの実装へ到達するかは実行時に決まるため、経路・層数は示していません。</li></ul>'
        : '';
      const iceptSum = listSec('🛡 インターセプタ(全 RPC の前段)', meta.interceptors);
      const envSum = listSec('⚙ 設定(環境変数)', meta.envVars);
      sideEl.innerHTML =
        `<h3>${KIND_ICON[n.kind] || '◆'} ${esc(n.label)}</h3>` +
        `<div class="sub">${esc(n.id)}</div>` +
        isolated +
        `<div class="sec">依存先サービス (${outMap.size})</div>` +
        `<div class="svclist">${sorted(outMap).map(svcItem).join('') || '<div class="sub">なし</div>'}</div>` +
        `<div class="sec">依存元サービス (${inMap.size})</div>` +
        `<div class="svclist">${sorted(inMap).map(svcItem).join('') || '<div class="sub">なし</div>'}</div>` +
        apiSum +
        relaySum +
        iceptSum +
        envSum +
        buildPathSection(n);
      const apiBtn = sideEl.querySelector('#btn-svc-api');
      if (apiBtn)
        apiBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          state.apiSvcFilter = protoSvcNames.size === 1 ? [...protoSvcNames][0] : '';
          setTab('api');
        });
      return;
    }

    // 表示中の集約エッジから in/out を拾う
    const arcs = computeArcs();
    const outs = arcs.filter((a) => a.u === n.id);
    const ins = arcs.filter((a) => a.v === n.id);
    const list = (items, dir) =>
      items
        .sort((a, b) => b.count - a.count)
        .map((a) => {
          const other = dir === 'out' ? a.v : a.u;
          const otherNode = byId.get(other);
          return `<li data-id="${esc(other)}"><span>${KIND_ICON[(otherNode || {}).kind] || '·'}</span> ${esc(otherNode ? otherNode.label : other)} <span class="cnt">${a.count}</span></li>`;
        })
        .join('');
    const isCallable = n.kind === 'func' || n.kind === 'rpc' || n.kind === 'file';
    const traceButtons = isCallable
      ? `<div class="btns">` +
        `<button id="btn-trace-down" class="${state.traceDir === 'down' ? 'active' : ''}">↓ 下流を辿る</button>` +
        `<button id="btn-trace-up" class="${state.traceDir === 'up' ? 'active' : ''}">↑ 上流を辿る</button>` +
        (state.traceDir ? `<button id="btn-trace-clear">解除</button>` : '') +
        `</div>`
      : '';
    let traceHtml = '';
    if (state.traceDir && isCallable) {
      const tree = traceTree(n.id, state.traceDir, 10);
      traceHtml = `<div class="sec">コールツリー(${state.traceDir === 'down' ? '下流' : '上流'})</div><div class="tracetree">${renderTraceNode(tree, undefined, true)}</div>`;
    }
    const metaInfo = [];
    if (n.lang) metaInfo.push(n.lang);
    if (n.loc) metaInfo.push(n.loc + ' 行');
    const services = n.meta && n.meta.services ? `<div class="sub">service: ${esc(n.meta.services.join(', '))}</div>` : '';
    const docHtml = n.meta && n.meta.doc ? `<div class="rpcdoc sidedoc">${esc(n.meta.doc)}</div>` : '';
    sideEl.innerHTML =
      `<h3>${KIND_ICON[n.kind] || '·'} ${esc(n.label)}</h3>` +
      docHtml +
      `<div class="sub">${esc(n.id)}<br>${metaInfo.join(' ・ ')} ${fileLink(n)}</div>` +
      services +
      traceButtons +
      traceHtml +
      buildPathSection(n) +
      `<div class="sec">依存先 (${outs.length})</div><ul>${list(outs, 'out') || '<li class="sub">なし</li>'}</ul>` +
      `<div class="sec">依存元 (${ins.length})</div><ul>${list(ins, 'in') || '<li class="sub">なし</li>'}</ul>`;
    const bindTrace = (sel, dir) => {
      const el = sideEl.querySelector(sel);
      if (el)
        el.addEventListener('click', () => {
          state.traceDir = state.traceDir === dir ? null : dir;
          render();
        });
    };
    bindTrace('#btn-trace-down', 'down');
    bindTrace('#btn-trace-up', 'up');
    const clearBtn = sideEl.querySelector('#btn-trace-clear');
    if (clearBtn)
      clearBtn.addEventListener('click', () => {
        state.traceDir = null;
        render();
      });
  }

  // ---------- API ビュー(proto カタログ + フロー + ソース §8.5) ----------
  const apiViewEl = $('#apiview');
  const apiListEl = $('#apilist');
  const apiFlowEl = $('#apiflow');
  const apiSrcEl = $('#apisrc');
  const IS_STATIC = !!window.STRATA_MODEL; // export された HTML では /source が使えない

  // 生成物(artifact)は元 proto が手元に無い API の唯一の定義元なので、proto と同じ棚に並べる。
  // 元 proto が手元にある生成物は RPC を持たない(定義は proto 側)ので棚には出さない
  const hasRpcChild = (id) => model.nodes.some((c) => c.parent === id && c.kind === 'rpc');
  const protoNodes = model.nodes
    .filter((n) => n.kind === 'proto' || (n.kind === 'artifact' && hasRpcChild(n.id)))
    .sort((a, b) => a.id.localeCompare(b.id));
  const artifactCount = protoNodes.filter((n) => n.kind === 'artifact').length;
  // mock 判定: パス片・ファイル名の mock/mocks、型名の Mock〜。
  // gomock(mock_foo.go / mocks/foo.go)と手書きの MockFooClient のどちらも拾う
  const MOCK_PATH = /(^|[/_.-])mocks?([/_.-]|$)/i;
  const MOCK_TYPE = /(^|[#./])Mock[A-Z0-9_]/;
  function isMockNode(id) {
    if (MOCK_PATH.test(id) || MOCK_TYPE.test(id)) return true;
    const file = ((byId.get(id) || {}).meta || {}).file;
    return typeof file === 'string' && MOCK_PATH.test(file);
  }
  /** mock を外した集合(除外オフならそのまま返す)。 */
  function withoutMocks(set) {
    if (!state.apiExcludeMocks || !set || set.size === 0) return set || new Set();
    const out = new Set();
    for (const id of set) if (!isMockNode(id)) out.add(id);
    return out;
  }

  const rpcCallers = new Map(); // rpc id -> Set(呼び出し元 func id)
  const rpcImpls = new Map(); // rpc id -> Set(実装 func id)
  for (const e of model.edges) {
    // API 表面(gRPC / HTTP / GraphQL)への呼び出しは同じ索引にまとめる
    if (e.kind === 'rpc' || e.kind === 'http' || e.kind === 'graphql') {
      if (!rpcCallers.has(e.to)) rpcCallers.set(e.to, new Set());
      rpcCallers.get(e.to).add(e.from);
    } else if (e.kind === 'impl') {
      if (!rpcImpls.has(e.from)) rpcImpls.set(e.from, new Set());
      rpcImpls.get(e.from).add(e.to);
    }
  }
  // HTTP ルート / GraphQL フィールド(gRPC 以外の API 表面)
  const SURFACE_HTTP_ID = 'surface:http';
  const SURFACE_GQL_ID = 'surface:graphql';
  const routeNodes = model.nodes
    .filter((n) => n.kind === 'route' && !(n.meta && n.meta.external))
    .sort((a, b) => (a.meta?.path || a.label).localeCompare(b.meta?.path || b.label));
  const gqlNodes = model.nodes
    .filter((n) => n.kind === 'gqlfield')
    .sort((a, b) => a.label.localeCompare(b.label));
  const topLabelOfId = (id) => {
    const top = chain(id)[0];
    const tn = byId.get(top);
    return tn ? tn.label : top;
  };
  // ソース表示に使うファイルパス(func は meta.file、proto/file は id がそのままパス)
  function fileOf(n) {
    if (!n) return null;
    if (n.meta && n.meta.file) return n.meta.file;
    if (n.kind === 'proto' || n.kind === 'file') return n.id;
    // RPC は親の proto ファイルにフォールバック
    if (n.kind === 'rpc' && n.parent !== undefined && (byId.get(n.parent) || {}).kind === 'proto') return n.parent;
    if (n.kind === 'gqlfield' && n.parent !== undefined && (byId.get(n.parent) || {}).kind === 'file') return n.parent;
    return null;
  }

  // ---------- 検索つきコンボボックス(select の代替) ----------
  // 一覧が長いサービス選択などで、文字入力による絞り込みを可能にする。
  function comboMarkup(key, current, placeholder, options) {
    const items = options
      .map(
        (o) =>
          `<div class="combo-item${o.value === current ? ' sel' : ''}" data-value="${esc(o.value)}">${esc(o.label)}</div>`,
      )
      .join('');
    return (
      `<div class="combo" data-combo="${esc(key)}">` +
      `<input class="combo-input" type="text" value="${esc(current)}" placeholder="${esc(placeholder)}" ` +
      `autocomplete="off" spellcheck="false" title="クリックして一覧から選ぶか、入力して絞り込み">` +
      `<div class="combo-list hidden">${items}</div></div>`
    );
  }
  function comboOpen(combo) {
    const list = combo.querySelector('.combo-list');
    if (!list) return;
    list.classList.remove('hidden');
    for (const item of combo.querySelectorAll('.combo-item')) item.classList.remove('hidden');
    const input = combo.querySelector('.combo-input');
    if (input && input.select) input.select();
  }
  function comboFilter(combo) {
    const input = combo.querySelector('.combo-input');
    const q = (input && input.value ? input.value : '').toLowerCase();
    combo.querySelector('.combo-list').classList.remove('hidden');
    for (const item of combo.querySelectorAll('.combo-item')) {
      const hit = q === '' || item.textContent.toLowerCase().includes(q) || item.dataset.value === '';
      item.classList.toggle('hidden', !hit);
    }
  }
  function bindCombos(rootEl, apply) {
    rootEl.addEventListener('focusin', (ev) => {
      const combo = ev.target.closest && ev.target.closest('.combo');
      if (combo && ev.target.classList.contains('combo-input')) comboOpen(combo);
    });
    rootEl.addEventListener('input', (ev) => {
      const combo = ev.target.closest && ev.target.closest('.combo');
      if (combo && ev.target.classList.contains('combo-input')) comboFilter(combo);
    });
    rootEl.addEventListener('mousedown', (ev) => {
      const item = ev.target.closest && ev.target.closest('.combo-item');
      if (!item) return;
      ev.preventDefault();
      const combo = item.closest('.combo');
      apply(combo.dataset.combo, item.dataset.value);
    });
    rootEl.addEventListener('keydown', (ev) => {
      const combo = ev.target.closest && ev.target.closest('.combo');
      if (!combo || !ev.target.classList.contains('combo-input')) return;
      if (ev.key === 'Enter') {
        const first = combo.querySelector('.combo-item:not(.hidden):not([data-value=""])');
        const q = ev.target.value.trim();
        apply(combo.dataset.combo, q === '' ? '' : first ? first.dataset.value : q);
      } else if (ev.key === 'Escape') {
        combo.querySelector('.combo-list').classList.add('hidden');
        ev.stopPropagation();
      }
    });
    rootEl.addEventListener('focusout', (ev) => {
      const combo = ev.target.closest && ev.target.closest('.combo');
      if (!combo) return;
      setTimeout(() => {
        if (typeof document !== 'undefined' && !combo.contains(document.activeElement)) {
          const list = combo.querySelector('.combo-list');
          if (list) list.classList.add('hidden');
        }
      }, 120);
    });
  }

  function renderApiList() {
    const q = state.q.toLowerCase();
    const filtering =
      q !== '' ||
      state.apiSvcFilter !== '' ||
      state.apiCallerFilter !== '' ||
      state.apiUsage.size > 0 ||
      state.apiAttrs.size > 0 ||
      state.apiExcludeMocks;
    // 空表示の案内文だけは「コードに出てくるものだけ」も絞り込みとして数える。
    // filtering 側に入れると、既定 ON なので節が常に開きっぱなしになる(「全て畳む」が効かない)
    const anyFilter = filtering || state.apiUsedOnly;
    const groups = new Map(); // ディレクトリ -> proto nodes
    const allSvcs = new Set(); // フィルタ用のサービス名一覧
    let rpcTotal = 0;
    let rpcShown = 0;
    const sections = [];
    for (const p of protoNodes) {
      const rpcKids = (childrenOf.get(p.id) || []).filter((id) => (byId.get(id) || {}).kind === 'rpc');
      rpcTotal += rpcKids.length;
      for (const id of rpcKids) {
        const label = byId.get(id).label;
        if (label.includes('.')) allSvcs.add(label.slice(0, label.indexOf('.')));
      }
      // 生成物はノード id に artifact: 接頭辞が付くので、見出しでは落とす
      const dirId = p.id.replace(/^artifact:/, '');
      const dir = dirId.includes('/') ? dirId.slice(0, dirId.lastIndexOf('/')) : '(ルート)';
      if (!groups.has(dir)) groups.set(dir, []);
      groups.get(dir).push({ p, rpcKids });
    }
    for (const [dir, list] of groups) {
      const files = [];
      for (const { p, rpcKids } of list) {
        // 検索: proto 名 / service 名 / RPC 名のどれかに一致したものだけ表示
        const svcNames = (p.meta && p.meta.services) || [];
        const matches = (s) => !q || String(s).toLowerCase().includes(q);
        const rpcItems = new Map(); // rpc id -> { html, calls }
        for (const id of rpcKids) {
          const label = byId.get(id).label;
          const svc = label.includes('.') ? label.slice(0, label.indexOf('.')) : '(service)';
          if (state.apiSvcFilter && svc !== state.apiSvcFilter) continue;
          const callers = withoutMocks(rpcCallers.get(id));
          const impls = withoutMocks(rpcImpls.get(id));
          const meta = (byId.get(id) || {}).meta || {};
          const testN = state.apiExcludeTests ? 0 : meta.testCallers || 0;
          const callerSvcs = new Set([...callers].map((c) => topLabelOfId(c)));
          if (state.apiCallerFilter) {
            if (state.apiCallerFilter === '(test)') {
              if (testN === 0) continue;
            } else if (!callerSvcs.has(state.apiCallerFilter)) {
              continue;
            }
          }
          // 取り込んだ proto カタログのうち、このワークスペースのコードに出てこない RPC を落とす。
          // 呼び出しか実装のどちらかがあれば「出てくる」とみなす
          if (state.apiUsedOnly && callers.size === 0 && impls.size === 0 && testN === 0) continue;
          // 使用状況(排他的な3区分)と属性: グループ内は 含む(OR)+ 除外、グループ間は AND
          const usage = callers.size > 0 ? 'called' : testN > 0 ? 'testonly' : 'dead';
          if (state.apiUsage.get(usage) === 'exc') continue;
          const usageInc = [...state.apiUsage].filter(([, v]) => v === 'inc').map(([k]) => k);
          if (usageInc.length > 0 && !usageInc.includes(usage)) continue;
          const hasAttr = {
            noimpl: impls.size === 0,
            deprecated: !!meta.deprecated,
            stream: !!meta.streaming,
          };
          let attrExcluded = false;
          const attrInc = [];
          for (const [k, v] of state.apiAttrs) {
            if (v === 'exc' && hasAttr[k]) attrExcluded = true;
            else if (v === 'inc') attrInc.push(k);
          }
          if (attrExcluded) continue;
          if (attrInc.length > 0 && !attrInc.some((k) => hasAttr[k])) continue;
          // 検索はメッセージ型名(リクエスト/レスポンス)にもヒットする
          if (
            !(
              matches(label) ||
              matches(p.label) ||
              svcNames.some(matches) ||
              matches(meta.req || '') ||
              matches(meta.res || '')
            )
          )
            continue;
          const str = meta.streaming
            ? ` <span class="warnmark badge-stream" title="${esc(meta.streaming)} streaming">⇄</span>`
            : '';
          const dep = meta.deprecated
            ? ' <span class="warnmark badge-dep" title="option deprecated = true">deprecated</span>'
            : '';
          const warn =
            impls.size === 0
              ? ' <span class="warnmark badge-noimpl" title="実装ハンドラが未検出">実装なし</span>'
              : '';
          const dead =
            callers.size === 0
              ? testN > 0
                ? ` <span class="warnmark badge-test" title="本番コードからの呼び出しは未検出だが、テスト(${testN} ファイル)は呼んでいる">テストのみ</span>`
                : ' <span class="warnmark badge-dead" title="呼び出し元が未検出(未使用の可能性)">未使用?</span>'
              : '';
          const shortLabel = label.includes('.') ? label.slice(label.indexOf('.') + 1) : label;
          const selected = state.apiRpc === id ? ' selected' : '';
          const docLine = meta.doc
            ? `<div class="rpcdoc" title="${esc(meta.doc)}">${esc(meta.doc)}</div>`
            : '';
          const hoverInfo =
            `${label}${meta.doc ? ' — ' + meta.doc : ''}\n` +
            `呼び出し元: ${callers.size > 0 ? [...callerSvcs].join(', ') : '未検出'}\n` +
            'クリックすると呼び出し元(上流)と実装からのフロー(下流)を表示します';
          rpcItems.set(id, {
            calls: callers.size,
            html:
              `<li class="rpc-item${selected}" data-rpc="${esc(id)}" title="${esc(hoverInfo)}">⚡ ${esc(shortLabel)}${str}${dep}${warn}${dead}` +
              `<span class="cnt" title="呼び出し元サービス">${callers.size > 0 ? [...callerSvcs].map(esc).join(', ') : ''}</span>` +
              docLine +
              `</li>`,
          });
        }
        rpcShown += rpcItems.size;
        if (rpcItems.size === 0 && anyFilter) continue; // 絞り込み中は一致なしの proto を出さない(見出しだけ残さない)
        // service ごとに RPC を束ねる(RPC label は "Service.Rpc")。呼び出し数順は各グループ内で適用
        let entries = [...rpcItems.entries()];
        if (state.apiSort === 'calls') entries = entries.sort((a, b) => b[1].calls - a[1].calls);
        let inner = '';
        const itemBySvc = new Map();
        for (const [id, ent] of entries) {
          const label = byId.get(id).label;
          const svc = label.includes('.') ? label.slice(0, label.indexOf('.')) : '(service)';
          if (!itemBySvc.has(svc)) itemBySvc.set(svc, []);
          itemBySvc.get(svc).push(ent.html);
        }
        for (const [svc, items] of itemBySvc) {
          inner += `<div class="svcname">${esc(svc)}</div><ul>${items.join('')}</ul>`;
        }
        // 折りたたみ(検索・フィルタ中は強制展開して一致を見せる)
        const collapsed = !filtering && state.apiCollapsed.has(p.id);
        files.push(
          `<div class="protofile">` +
            `<div class="pfhead">` +
            `<span class="pftw" data-pf="${esc(p.id)}" title="折りたたみ">${collapsed ? '▸' : '▾'}</span>` +
            `<span class="pfname" data-proto="${esc(p.id)}" title="${p.meta && p.meta.doc ? esc(p.meta.doc) + '\n' : ''}クリックで proto を表示">⬡ ${esc(p.label)}</span>` +
            `<span class="pfcnt">${rpcItems.size}</span>` +
            `</div>` +
            (collapsed ? '' : inner) +
            `</div>`,
        );
      }
      if (files.length > 0) sections.push(`<div class="pkg">${esc(dir)}</div>` + files.join(''));
    }
    // ---- gRPC 以外の API 表面(HTTP ルート / GraphQL フィールド) ----
    // proto 固有のフィルタ(サービス選択・deprecated/stream)が効いているときは対象外
    const surfaceBlocked =
      state.apiSvcFilter !== '' ||
      [...state.apiAttrs].some(([k, v]) => v === 'inc' && k !== 'noimpl');
    let routeShown = 0;
    let gqlShown = 0;
    const surfaceSection = (nodes, icon, title, extraChips, sectionId) => {
      if (surfaceBlocked || nodes.length === 0) return '';
      const bySvc = new Map();
      for (const n of nodes) {
        const callers = withoutMocks(rpcCallers.get(n.id));
        const impls = withoutMocks(rpcImpls.get(n.id));
        const callerSvcs = new Set([...callers].map((c) => topLabelOfId(c)));
        if (state.apiCallerFilter) {
          if (state.apiCallerFilter === '(test)') continue;
          if (!callerSvcs.has(state.apiCallerFilter)) continue;
        }
        const usage = callers.size > 0 ? 'called' : 'dead';
        if (state.apiUsage.get(usage) === 'exc') continue;
        const usageInc = [...state.apiUsage].filter(([, v]) => v === 'inc').map(([k]) => k);
        if (usageInc.length > 0 && !usageInc.includes(usage)) continue;
        if (state.apiAttrs.get('noimpl') === 'exc' && impls.size === 0) continue;
        if (state.apiAttrs.get('noimpl') === 'inc' && impls.size > 0) continue;
        const meta = n.meta || {};
        const hay = `${n.label} ${meta.path || ''} ${meta.framework || ''} ${meta.gqlType || ''}`.toLowerCase();
        if (q && !hay.includes(q)) continue;
        const svc = topLabelOfId(n.id);
        if (!bySvc.has(svc)) bySvc.set(svc, []);
        const warn =
          impls.size > 0
            ? ''
            : meta.inlineHandler
              ? ' <span class="warnmark badge-fw" title="ルート登録の引数に直接書かれた無名関数">インライン</span>'
              : ' <span class="warnmark badge-noimpl" title="ハンドラ / リゾルバの実装が未検出">実装なし</span>';
        const dead =
          callers.size === 0
            ? ' <span class="warnmark badge-dead" title="呼び出し元が未検出(このリポジトリ内からは呼ばれていない)">呼び出し元なし</span>'
            : '';
        const selected = state.apiRpc === n.id ? ' selected' : '';
        const surfaceHover =
          `${n.label}${meta.framework ? ' (' + meta.framework + ')' : ''}\n` +
          `呼び出し元: ${callers.size > 0 ? [...callerSvcs].join(', ') : '未検出'}\n` +
          'クリックすると呼び出し元(上流)と実装からのフロー(下流)を表示します';
        bySvc.get(svc).push(
          `<li class="rpc-item${selected}" data-rpc="${esc(n.id)}" title="${esc(surfaceHover)}">${icon} ${esc(n.label)}${extraChips(n)}${warn}${dead}` +
            `<span class="cnt" title="呼び出し元">${callers.size > 0 ? [...callerSvcs].map(esc).join(', ') : ''}</span></li>`,
        );
        if (icon === '⇄') routeShown++;
        else gqlShown++;
      }
      if (bySvc.size === 0) return '';
      let inner = '';
      let count = 0;
      for (const [svc, items] of [...bySvc.entries()].sort()) {
        inner += `<div class="svcname">${esc(svc)}</div><ul>${items.join('')}</ul>`;
        count += items.length;
      }
      const collapsed = !filtering && state.apiCollapsed.has(sectionId);
      return (
        `<div class="protofile">` +
        `<div class="pfhead">` +
        `<span class="pftw" data-pf="${esc(sectionId)}" title="折りたたみ">${collapsed ? '▸' : '▾'}</span>` +
        `<span class="pfname">${icon} ${esc(title)}</span>` +
        `<span class="pfcnt">${count}</span>` +
        `</div>` +
        (collapsed ? '' : inner) +
        `</div>`
      );
    };
    const httpSection = surfaceSection(routeNodes, '⇄', 'HTTP エンドポイント', (n) => {
      const m = n.meta || {};
      return (
        (m.webhook ? ' <span class="warnmark badge-hook" title="webhook の受信口">webhook</span>' : '') +
        (m.framework
          ? ` <span class="warnmark badge-fw" title="検出したフレームワーク: ${esc(m.framework)}">${esc(m.framework)}</span>`
          : '')
      );
    }, SURFACE_HTTP_ID);
    const gqlSection = surfaceSection(gqlNodes, '◈', 'GraphQL', (n) => {
      const m = n.meta || {};
      return m.gqlType ? ` <span class="warnmark badge-fw" title="戻り値の型">${esc(m.gqlType)}</span>` : '';
    }, SURFACE_GQL_ID);
    if (httpSection) sections.push(httpSection);
    if (gqlSection) sections.push(gqlSection);
    // 3状態チップ: クリックで 含む(✓)→ 除外(✕)→ 解除 を巡回
    const cycleChip = (map, key, lbl, title) => {
      const st = map.get(key);
      const cls = st === 'inc' ? ' on' : st === 'exc' ? ' neg' : '';
      const mark = st === 'inc' ? '✓ ' : st === 'exc' ? '✕ ' : '';
      return `<button class="chip${cls}" data-chip="${key}" title="${title}\nクリックで 含む → 除外 → 解除">${mark}${lbl}</button>`;
    };
    const exclChip = (key, on, lbl, title) =>
      `<button class="chip excl${on ? ' on' : ''}" data-chip-excl="${key}" title="${title}">${lbl}</button>`;
    const svcOptions = [
      { value: '', label: `すべて (${allSvcs.size})` },
      ...[...allSvcs].sort().map((s) => ({ value: s, label: s })),
    ];
    // 呼び出し元サービスの一覧(フィルタ対象に関わらず全 RPC から集める)
    const allCallerSvcs = new Set();
    for (const set of rpcCallers.values()) for (const c of set) allCallerSvcs.add(topLabelOfId(c));
    const callerOptions = [
      { value: '', label: 'すべて' },
      { value: '(test)', label: '(テストから)' },
      ...[...allCallerSvcs].sort().map((s) => ({ value: s, label: s })),
    ];
    const filters =
      `<div class="filters">` +
      `<div class="frow"><label>サービス</label>${comboMarkup('svc', state.apiSvcFilter, `すべて (${allSvcs.size})`, svcOptions)}</div>` +
      `<div class="frow"><label>呼び出し元</label>${comboMarkup('caller', state.apiCallerFilter === '(test)' ? '(テストから)' : state.apiCallerFilter, 'すべて', callerOptions)}</div>` +
      `<div class="frow"><label>並び</label><select id="api-sort" title="サービス内の RPC の並び順">` +
      `<option value="name"${state.apiSort === 'name' ? ' selected' : ''}>名前順</option>` +
      `<option value="calls"${state.apiSort === 'calls' ? ' selected' : ''}>呼び出し数順</option>` +
      `</select></div>` +
      `<div class="frow chips"><label>使用状況</label><div class="chiprow">` +
      cycleChip(state.apiUsage, 'called', '本番で使用', '本番コードから呼ばれている RPC') +
      (state.apiExcludeTests ? '' : cycleChip(state.apiUsage, 'testonly', 'テストのみ', 'テストからだけ呼ばれている RPC')) +
      cycleChip(state.apiUsage, 'dead', '未使用', 'どこからも呼ばれていない RPC(死んだ API 候補)') +
      `</div></div>` +
      `<div class="frow chips"><label>属性</label><div class="chiprow">` +
      cycleChip(state.apiAttrs, 'noimpl', '実装なし', '実装ハンドラが見つからない RPC') +
      cycleChip(state.apiAttrs, 'deprecated', 'deprecated', 'proto で deprecated 指定された RPC') +
      cycleChip(state.apiAttrs, 'stream', 'stream', 'ストリーミング RPC') +
      `</div></div>` +
      `<div class="frow chips"><label>オプション</label><div class="chiprow">` +
      exclChip('mocks', state.apiExcludeMocks, 'mock を除外',
        'gomock などの生成物・手書きのモック(パスや型名の mock / Mock〜)を、呼び出し元・実装から外す') +
      exclChip('used', state.apiUsedOnly, 'コードに出てくるものだけ',
        'このワークスペースのコードから呼ばれている、または実装されている RPC だけを表示する。\n' +
        '取り込んだ proto カタログのうち、使っていない定義を隠す(HTTP / GraphQL はコード由来なので常に表示)') +
      exclChip('tests', state.apiExcludeTests, 'テスト呼び出しを無視', 'テストからの呼び出しを無視して、本番コードだけで使用状況を判定する') +
      `</div></div>` +
      `</div>`;
    const shownNote = rpcShown !== rpcTotal ? ` ・ <b>表示中 ${rpcShown}</b>` : '';
    // 適用中のフィルタ数(畳んでいても効いていることが分かるように)
    const activeFilters =
      (state.apiSvcFilter ? 1 : 0) +
      (state.apiCallerFilter ? 1 : 0) +
      (state.apiSort !== 'name' ? 1 : 0) +
      state.apiUsage.size +
      state.apiAttrs.size +
      (state.apiExcludeTests ? 1 : 0) +
      (state.apiUsedOnly ? 1 : 0) +
      (state.apiExcludeMocks ? 1 : 0);
    const ftoggle =
      `<button class="ftoggle${activeFilters > 0 ? ' active' : ''}" data-ftoggle="1" ` +
      `title="フィルタを${state.apiFilterCollapsed ? '開く' : '畳む'}">` +
      `${state.apiFilterCollapsed ? '▸' : '▾'} フィルタ${activeFilters > 0 ? ` <b>${activeFilters}</b>` : ''}</button>`;
    const surfaceSum =
      (routeNodes.length > 0 ? ` ・ ${routeNodes.length} HTTP` : '') +
      (gqlNodes.length > 0 ? ` ・ ${gqlNodes.length} GraphQL` : '');
    const sum =
      `${protoNodes.length - artifactCount} proto` +
      (artifactCount > 0 ? ` ・ ${artifactCount} 生成物` : '') +
      ` ・ ${allSvcs.size} service ・ ${rpcTotal} RPC${surfaceSum}${shownNote}` +
      ` <span class="mini" data-pfall="collapse">全て畳む</span><span class="mini" data-pfall="expand">全て開く</span>`;
    apiListEl.innerHTML =
      `<div class="apihead">` +
      `<div class="sum">${ftoggle}${sum}</div>` +
      (state.apiFilterCollapsed ? '' : filters) +
      `</div>` +
      unresolvedSection() +
      (sections.join('') ||
        (anyFilter
          ? '<div class="sum">フィルタに一致する API がありません</div>'
          : '<div class="sum">API(proto / HTTP ルート / GraphQL スキーマ)が見つかりませんでした。</div>'));
    if (typeof updateApiHeadMin === 'function') updateApiHeadMin();
  }

  // 解決できなかった参照。推測で線を引かずに残したものを、設定を書く手掛かりとして見せる
  const UNRESOLVED_LABEL = {
    artifact: '生成物から逆引き不可',
    env: '環境変数が未解決',
    dynamic: '動的生成',
  };

  function unresolvedSection() {
    const list = model.unresolved || [];
    if (list.length === 0) return '';
    const rows = list
      .map((u) => {
        const where = u.file ? `${u.file}${u.line ? ':' + u.line : ''}` : u.from;
        const jump = u.file ? ' jump' : '';
        return (
          `<li class="rpc-item unres-item${jump}" data-unres-file="${esc(u.file || '')}" data-unres-line="${u.line || 1}"` +
          ` title="${esc(u.hint || '')}">` +
          `<span class="warnmark badge-unres">${esc(UNRESOLVED_LABEL[u.reason] || u.reason)}</span> ${esc(u.detail)}` +
          `<span class="cnt">${esc(where)}</span></li>`
        );
      })
      .join('');
    return (
      `<div class="protosec unres">` +
      `<div class="sum">未解決の参照 ${list.length} 件 — 決め手が無いので繋いでいません` +
      `(strata.config.json の indirection / infra で繋がる可能性があります)</div>` +
      `<ul class="rpclist">${rows}</ul></div>`
    );
  }

  // フロー図: RPC → 実装サービス → 関数 → … → 別サービスの RPC → … を入れ子で描く
  function renderFlowNode(node, parentTop, isRoot, dir) {
    const n = byId.get(node.id);
    if (!n) return '';
    const top = chain(node.id)[0];
    const crossed = parentTop !== undefined && top !== parentTop;
    const chip = crossed
      ? `<span class="svcchip${node.kind === 'impl' ? ' impl' : ''}" title="${node.kind === 'impl' ? '実装サービス' : 'サービス境界'}">${esc(topLabelOfId(node.id))}</span>`
      : '';
    const arrow = isRoot ? '' : `<span class="arrow">${dir === 'up' ? '←' : '→'}</span>`;
    const icon = `<span class="ic ${n.kind === 'rpc' ? 'rpc' : 'func'}">${KIND_ICON[n.kind] || 'ƒ'}</span>`;
    const file = fileOf(n);
    const lineNo = n.meta && n.meta.line ? n.meta.line : null;
    const floc = file
      ? `<span class="floc">${esc(file.split('/').pop())}${lineNo ? ':' + lineNo : ''}</span>`
      : '';
    // 呼び出し箇所チップ: どの行から呼ばれているかへ直接飛べる
    const site = node.sites && node.sites.length > 0 ? node.sites[0] : null;
    const siteChip = site
      ? `<span class="fsite" data-srcfile="${esc(site.f)}" data-srcline="${site.l}" ` +
        `title="呼び出し箇所を開く: ${esc(site.f)}:${site.l}` +
        (node.sites.length > 1 ? `(他 ${node.sites.length - 1} 箇所)` : '') +
        `">呼出 ${esc(site.f.slice(site.f.lastIndexOf('/') + 1))}:${site.l}</span>`
      : '';
    const cyc = node.cycle ? '<span class="cycmark">↻ 循環</span>' : '';
    const trunc = node.truncated ? '<span class="floc">…(深さ上限)</span>' : '';
    const selected = state.apiSel === node.id && !node.cycle ? ' selected' : '';
    const kids = node.children.map((c) => renderFlowNode(c, top, false, dir)).join('');
    // ホバーで説明文(docコメント)を表示。無ければノード ID
    const hoverTitle = n.meta && n.meta.doc ? `${n.label} — ${n.meta.doc}` : n.id;
    return (
      `<div class="fnode${isRoot ? ' root' : ''}">` +
      `<div class="frow${selected}" data-flow="${esc(node.id)}" title="${esc(hoverTitle)}">` +
      arrow +
      icon +
      chip +
      `<span class="lb">${esc(n.label)}</span>` +
      floc +
      siteChip +
      cyc +
      trunc +
      `</div>` +
      kids +
      `</div>`
    );
  }

  function renderApiFlow() {
    if (!state.apiRpc || !byId.has(state.apiRpc)) {
      apiFlowEl.innerHTML =
        '<div class="placeholder">左の一覧から ⚡RPC ・ ⇄HTTP エンドポイント ・ ◈GraphQL フィールドを選ぶと、' +
        '実装サービス → 関数 → 下流サービスへと流れるコールフローを表示します。<br>' +
        '関数をクリックすると実際のソースコードを読めます。</div>';
      return;
    }
    const n = byId.get(state.apiRpc);
    const skipMocks = state.apiExcludeMocks;
    const downTree = traceTree(n.id, 'down', 12, { skipMocks, dedupeCoarse: true });
    // 上流は「別のマイクロサービスまで」辿れる深さが要る。
    // handler → usecase → …(数段)→ 実装 → RPC → 呼び出し元 とホップするため
    const upTree = traceTree(n.id, 'up', 12, { skipMocks, dedupeCoarse: true });
    const impls = withoutMocks(rpcImpls.get(n.id));
    const callers = withoutMocks(rpcCallers.get(n.id));
    const protoFile = fileOf(n) || (n.parent ? n.parent : '');
    const implNote =
      impls.size > 0
        ? ''
        : (n.meta || {}).inlineHandler
          ? '<div class="sub">ハンドラはルート登録の引数に直接書かれた無名関数です(独立した実装ノードはありません)</div>'
          : '<div class="sub">⚠ 実装ハンドラ / リゾルバが未検出です(未対応言語の実装・interface 越しの登録は検出されません)</div>';
    const callerHtml =
      callers.size > 0
        ? `<div class="flow">${upTree.children.map((c) => renderFlowNode(c, chain(n.id)[0], false, 'up')).join('')}</div>`
        : '<div class="sub">呼び出し元は検出されませんでした</div>';
    const testFiles = state.apiExcludeTests ? [] : (n.meta && n.meta.testFiles) || [];
    const testHtml =
      testFiles.length > 0
        ? `<div class="sec">テストからの呼び出し (${n.meta.testCallers})</div><ul class="testfiles">` +
          testFiles
            .map((f) => `<li data-srcfile="${esc(f)}" title="クリックでテストコードを表示">🧪 ${esc(f)}</li>`)
            .join('') +
          `</ul>`
        : '';
    // 実装サービスの横断インターセプタ(認可等)を前段の処理として明示する
    const iceptSet = new Set();
    for (const impl of impls) {
      const sn = byId.get(chain(impl)[0]);
      if (sn && sn.meta && sn.meta.interceptors) for (const ic of sn.meta.interceptors) iceptSet.add(ic);
    }
    const iceptNote =
      iceptSet.size > 0
        ? `<div class="sub">🛡 このRPCは実装サービスの横断インターセプタを前段で通ります: ${esc([...iceptSet].join(' → '))}</div>`
        : '';
    const nm = n.meta || {};
    const flags =
      (nm.deprecated ? ' <span class="warnmark badge-dep">deprecated</span>' : '') +
      (nm.streaming ? ` <span class="warnmark badge-stream" title="streaming">⇄ ${esc(nm.streaming)}</span>` : '') +
      (nm.webhook ? ' <span class="warnmark badge-hook" title="webhook の受信口 / 送信先">webhook</span>' : '') +
      (nm.framework ? ` <span class="warnmark badge-fw" title="検出したフレームワーク">${esc(nm.framework)}</span>` : '');
    const sig = nm.req
      ? `<div class="sub">${nm.streaming === 'client' || nm.streaming === 'bidi' ? 'stream ' : ''}${esc(nm.req)} → ` +
        `${nm.streaming === 'server' || nm.streaming === 'bidi' ? 'stream ' : ''}${esc(nm.res)}</div>`
      : nm.gqlType
        ? `<div class="sub">${esc(nm.gqlKind || 'query')} → ${esc(nm.gqlType)}</div>`
        : nm.method
          ? `<div class="sub">${esc(nm.method)} ${esc(nm.path || '')}</div>`
          : '';
    const docHtml = nm.doc ? `<div class="rpcdoc flowdoc">${esc(nm.doc)}</div>` : '';
    const headIcon = n.kind === 'route' ? '⇄' : n.kind === 'gqlfield' ? '◈' : '⚡';
    apiFlowEl.innerHTML =
      `<h2><span class="rpcmark">${headIcon}</span> ${esc(n.label)}${flags}</h2>` +
      docHtml +
      sig +
      `<div class="sub">${esc(protoFile)} ${fileLink(n)}</div>` +
      implNote +
      iceptNote +
      `<div class="sec">呼び出し元(この API を呼ぶ側・上流)</div>` +
      callerHtml +
      testHtml +
      `<div class="sec">フロー(実装 → 下流)</div>` +
      `<div class="flow">${renderFlowNode(downTree, undefined, true, 'down')}</div>`;
  }

  /** 読み込み中の表示。待たせる画面はすべてこれを出す(無言で固まって見えるのを避ける)。 */
  function loadingHtml(message) {
    return `<div class="loadbox" role="status" aria-live="polite"><span class="spin" aria-hidden="true"></span>${esc(message)}</div>`;
  }

  // ---------- ソースビューア ----------
  const srcCache = new Map(); // 相対パス -> Promise<string>
  function fetchSource(rel) {
    if (!srcCache.has(rel)) {
      const p = fetch('source?f=' + encodeURIComponent(rel) + projQS('&'))
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json().then((j) => j.content);
        })
        // 失敗した Promise をキャッシュに残すと、一時エラー後そのファイルが二度と開けなくなる
        .catch((err) => {
          srcCache.delete(rel);
          throw err;
        });
      srcCache.set(rel, p);
    }
    return srcCache.get(rel);
  }

  async function openSource(id) {
    const n = byId.get(id);
    const rel = fileOf(n);
    if (!rel) {
      apiSrcEl.classList.add('hidden');
      return;
    }
    const lineNo = n.meta && n.meta.line ? n.meta.line : n.kind === 'proto' ? 1 : null;
    await openSourceFile(rel, lineNo, fileLink(n) || '');
  }

  // ソースパネルの状態(ファイルツリー含む)
  const srcState = {
    file: null,
    line: null,
    link: '',
    treeVisible: false,
    treeFilter: '',
    treeExpanded: new Set(),
    filesPromise: null, // /files の結果キャッシュ
    renderSeq: 0, // 描画の世代。読み込み中に別ファイルを開かれたら古い結果を捨てる
    history: [], // 定義ジャンプ等の「戻る」用
    blameVisible: false, // git blame ガターの表示
    blameCache: new Map(), // rel -> {byLine: Map(行 -> info)} | {error}
  };

  // ⌘クリックの定義ジャンプ用: 関数 / RPC / proto message / 型 -> 定義位置
  const funcDefIndex = new Map();
  const addDef = (name, file, line, doc) => {
    if (!funcDefIndex.has(name)) funcDefIndex.set(name, []);
    funcDefIndex.get(name).push({ file, line, doc });
  };
  for (const n of model.nodes) {
    const meta = n.meta || {};
    if ((n.kind === 'func' || n.kind === 'rpc') && meta.file && meta.line) {
      const names = new Set([n.label]);
      const dot = n.label.lastIndexOf('.');
      if (dot >= 0) names.add(n.label.slice(dot + 1));
      for (const name of names) addDef(name, meta.file, meta.line, meta.doc);
    }
    // proto の message / enum(proto ノードの meta.messages: {名前: 行})
    if (meta.messages) {
      for (const [name, line] of Object.entries(meta.messages)) addDef(name, n.id, line);
    }
    // Go の type / TS の interface・class・type(meta.typeDefs: {名前: {f, l}})
    if (meta.typeDefs) {
      for (const [name, d] of Object.entries(meta.typeDefs)) addDef(name, d.f, d.l);
    }
  }

  function wordAtPoint(ev) {
    let node = null;
    let offset = 0;
    if (document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(ev.clientX, ev.clientY);
      if (!r) return null;
      node = r.startContainer;
      offset = r.startOffset;
    } else if (document.caretPositionFromPoint) {
      const p = document.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (!p) return null;
      node = p.offsetNode;
      offset = p.offset;
    }
    if (!node || node.nodeType !== 3) return null;
    const text = node.textContent;
    const isWordCh = (c) => /[\w$]/.test(c);
    let s = offset;
    let e = offset;
    while (s > 0 && isWordCh(text[s - 1])) s--;
    while (e < text.length && isWordCh(text[e])) e++;
    const w = text.slice(s, e);
    return w.length > 1 ? w : null;
  }

  function jumpToDefinition(word) {
    const defs = funcDefIndex.get(word);
    if (!defs || defs.length === 0) return false;
    const cur = srcState.file || '';
    const top = cur.split('/')[0];
    // 同一ファイル → 同一トップディレクトリ(サービス)→ 先頭 の順で選ぶ
    const target =
      defs.find((d) => d.file === cur && d.line !== srcState.line) ||
      defs.find((d) => d.file.split('/')[0] === top) ||
      defs[0];
    openSourceFile(target.file, target.line);
    return true;
  }

  // ---- 定義ホバープレビュー(識別子にカーソルを合わせると定義のコード断片を表示) ----
  const defPeekEl = $('#defpeek');
  const peekState = { timer: null, hideTimer: null, word: null, overPeek: false };

  function pickDef(word) {
    const defs = funcDefIndex.get(word);
    if (!defs || defs.length === 0) return null;
    const cur = srcState.file || '';
    const top = cur.split('/')[0];
    return (
      defs.find((d) => d.file === cur && d.line !== srcState.line) ||
      defs.find((d) => d.file.split('/')[0] === top) ||
      defs[0]
    );
  }

  function hideDefPeek() {
    if (peekState.timer) clearTimeout(peekState.timer);
    if (peekState.hideTimer) clearTimeout(peekState.hideTimer);
    peekState.timer = null;
    peekState.hideTimer = null;
    peekState.word = null;
    defPeekEl.classList.add('hidden');
  }

  async function showDefPeek(word, x, y) {
    const def = pickDef(word);
    if (!def) return;
    // 自分自身(いま表示中の定義行)へのプレビューは出さない
    if (def.file === srcState.file && def.line === srcState.line) return;
    peekState.word = word;
    let codeHtml = '';
    if (!IS_STATIC) {
      try {
        const content = await fetchSource(def.file);
        if (peekState.word !== word) return; // ホバーが移った
        const lines = content.split('\n');
        const ext = def.file.slice(def.file.lastIndexOf('.') + 1).toLowerCase();
        const lang = HL_EXT[ext];
        const hlState = { inBlock: false };
        const from = def.line - 1;
        const to = Math.min(lines.length, from + 12);
        const parts = [];
        for (let i = from; i < to; i++) {
          parts.push(`<div class="cl"><span class="ln">${i + 1}</span><span>${hlLine(lines[i] ?? '', lang, hlState)}</span></div>`);
        }
        if (to < lines.length) parts.push('<div class="cl"><span class="ln"></span><span class="tok-c">…</span></div>');
        codeHtml = `<div class="peekcode code">${parts.join('')}</div>`;
      } catch {
        codeHtml = '';
      }
    }
    const docHtml = def.doc ? `<div class="rpcdoc peekdoc">${esc(def.doc)}</div>` : '';
    defPeekEl.innerHTML =
      `<div class="peekhead" data-file="${esc(def.file)}" data-line="${def.line}" title="クリックで定義へ移動">` +
      `ƒ ${esc(word)} <span class="floc">${esc(def.file)}:${def.line}</span></div>` +
      docHtml +
      codeHtml;
    defPeekEl.classList.remove('hidden');
    // カーソルの近くに配置(画面下端・右端では折り返す)
    if (typeof x === 'number' && defPeekEl.style) {
      const vw = (typeof window !== 'undefined' && window.innerWidth) || 1400;
      const vh = (typeof window !== 'undefined' && window.innerHeight) || 900;
      const w = 620;
      const h = 300;
      defPeekEl.style.left = Math.max(8, Math.min(x + 14, vw - w - 8)) + 'px';
      defPeekEl.style.top = (y + 18 + h > vh ? Math.max(8, y - h - 10) : y + 18) + 'px';
    }
  }

  // ソースパネル内の関数名トークンにホバー → 少し待ってからプレビュー
  function bindDefPeek(container) {
    container.addEventListener('mouseover', (ev) => {
      const tok = ev.target.closest && ev.target.closest('.tok-f');
      if (!tok || !ev.target.closest('.code')) return;
      const word = (tok.textContent || '').trim();
      if (!word || !funcDefIndex.has(word)) return;
      if (peekState.timer) clearTimeout(peekState.timer);
      // 別トークンへ移った場合、直前の hide 予約が新しいプレビューを消さないようキャンセル
      if (peekState.hideTimer) clearTimeout(peekState.hideTimer);
      peekState.hideTimer = null;
      const x = ev.clientX;
      const y = ev.clientY;
      peekState.timer = setTimeout(() => showDefPeek(word, x, y), 220);
    });
    container.addEventListener('mouseout', (ev) => {
      const tok = ev.target.closest && ev.target.closest('.tok-f');
      if (!tok) return;
      if (peekState.timer) clearTimeout(peekState.timer);
      peekState.timer = null;
      // ポップアップ自体へ移動した場合は維持する。hide 予約は peekState に保持し、
      // 直後に別トークンへホバーしたら mouseover 側でキャンセルできるようにする
      if (peekState.hideTimer) clearTimeout(peekState.hideTimer);
      peekState.hideTimer = setTimeout(() => {
        peekState.hideTimer = null;
        if (!peekState.overPeek) hideDefPeek();
      }, 150);
    });
  }
  defPeekEl.addEventListener('mouseenter', () => {
    peekState.overPeek = true;
  });
  defPeekEl.addEventListener('mouseleave', () => {
    peekState.overPeek = false;
    hideDefPeek();
  });
  defPeekEl.addEventListener('click', (ev) => {
    const head = ev.target.closest && ev.target.closest('.peekhead');
    if (!head) return;
    const file = head.dataset.file;
    const line = parseInt(head.dataset.line, 10);
    hideDefPeek();
    if (file) openSourceFile(file, line);
  });

  function fetchFileList() {
    if (!srcState.filesPromise) {
      srcState.filesPromise = fetch('files' + projQS('?'))
        .then((r) => {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then((j) => j.files || []);
    }
    return srcState.filesPromise;
  }

  async function fetchBlame(rel) {
    if (srcState.blameCache.has(rel)) return srcState.blameCache.get(rel);
    let result;
    try {
      const r = await fetch('blame?f=' + encodeURIComponent(rel) + projQS('&'));
      const j = await r.json();
      if (j.error) {
        result = { error: j.error };
      } else {
        const byLine = new Map();
        for (const l of j.lines || []) byLine.set(l.line, l);
        result = { byLine };
      }
    } catch (err) {
      // ネットワーク等の一時エラーはキャッシュせず、次回再試行できるようにする
      return { error: String(err) };
    }
    srcState.blameCache.set(rel, result);
    return result;
  }
  function blameAge(timeSec) {
    const days = (Date.now() / 1000 - timeSec) / 86400;
    const label = days < 1 ? '今日' : days < 30 ? `${Math.floor(days)}d` : days < 365 ? `${Math.floor(days / 30)}mo` : `${Math.floor(days / 365)}y`;
    const cls = days < 30 ? 'bl-new' : days < 365 ? 'bl-mid' : 'bl-old';
    return { label, cls };
  }

  // ファイルツリーの一覧部分(絞り込み中はフラット表示)
  function treeListHtml(files) {
    const q = srcState.treeFilter.toLowerCase();
    if (q !== '') {
      const hits = files.filter((f) => f.toLowerCase().includes(q)).slice(0, 200);
      return (
        hits
          .map(
            (f) =>
              `<div class="titem file${f === srcState.file ? ' current' : ''}" data-tree-file="${esc(f)}" title="${esc(f)}">${esc(f)}</div>`,
          )
          .join('') || '<div class="titem none">一致なし</div>'
      );
    }
    // dir -> {dirs: Set, files: []} を構築
    const dirMap = new Map([['', { dirs: new Set(), files: [] }]]);
    for (const f of files) {
      const parts = f.split('/');
      let cur = '';
      for (const seg of parts.slice(0, -1)) {
        const parent = cur;
        cur = cur === '' ? seg : cur + '/' + seg;
        if (!dirMap.has(cur)) dirMap.set(cur, { dirs: new Set(), files: [] });
        dirMap.get(parent).dirs.add(cur);
      }
      dirMap.get(cur).files.push(f);
    }
    const render = (dir, depth) => {
      const node = dirMap.get(dir);
      if (!node) return '';
      let html = '';
      for (const d of [...node.dirs].sort()) {
        const open = srcState.treeExpanded.has(d);
        const name = d.slice(d.lastIndexOf('/') + 1);
        html += `<div class="titem dir" style="padding-left:${6 + depth * 12}px" data-tree-dir="${esc(d)}" title="${esc(d)}">${open ? '▾' : '▸'} ${esc(name)}</div>`;
        if (open) html += render(d, depth + 1);
      }
      for (const f of node.files.sort()) {
        const name = f.slice(f.lastIndexOf('/') + 1);
        html += `<div class="titem file${f === srcState.file ? ' current' : ''}" style="padding-left:${20 + depth * 12}px" data-tree-file="${esc(f)}" title="${esc(f)}">${esc(name)}</div>`;
      }
      return html;
    };
    return render('', 0);
  }

  // ---------- シンタックスハイライト(軽量・依存なし) ----------
  const HL_LANGS = {
    go: {
      line: '//', block: true,
      kw: 'break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|nil|true|false|iota|string|bool|byte|rune|error|any|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|float32|float64|complex64|complex128|make|new|len|cap|append|copy|delete|panic|recover|close',
    },
    js: {
      line: '//', block: true,
      kw: 'const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|import|export|from|default|async|await|try|catch|finally|throw|typeof|instanceof|of|in|yield|delete|void|this|super|null|undefined|true|false|interface|type|enum|implements|declare|readonly|public|private|protected|static|as|satisfies|keyof|namespace',
    },
    proto: {
      line: '//', block: true,
      kw: 'syntax|package|import|option|service|rpc|returns|message|enum|repeated|optional|required|reserved|oneof|stream|map|extend|extensions|string|bytes|bool|double|float|int32|int64|uint32|uint64|sint32|sint64|fixed32|fixed64|sfixed32|sfixed64|true|false',
    },
    ex: {
      line: '#', block: false,
      kw: 'def|defp|defmodule|defstruct|defimpl|defprotocol|defmacro|do|end|alias|import|require|use|case|cond|if|else|unless|with|fn|receive|after|rescue|try|catch|raise|throw|when|true|false|nil|not|and|or|in|quote|unquote',
    },
    yaml: { line: '#', block: false, kw: 'true|false|null' },
    sh: { line: '#', block: false, kw: 'if|then|else|elif|fi|for|in|do|done|while|case|esac|function|return|exit|export|local|echo|set' },
    sql: {
      line: '--', block: true,
      kw: 'SELECT|FROM|WHERE|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|DROP|ALTER|ADD|PRIMARY|KEY|FOREIGN|REFERENCES|NOT|NULL|DEFAULT|UNIQUE|AND|OR|IN|ON|JOIN|LEFT|RIGHT|INNER|OUTER|GROUP|BY|ORDER|LIMIT|OFFSET|AS|DISTINCT|COUNT|SUM|AVG|MAX|MIN|BEGIN|COMMIT|ROLLBACK|TRANSACTION|IF|EXISTS|CONSTRAINT|serial|bigserial|varchar|text|timestamp|timestamptz|boolean|integer|bigint|uuid|jsonb|numeric',
    },
    json: { line: null, block: false, kw: 'true|false|null' },
  };
  const HL_EXT = {
    go: 'go', ts: 'js', tsx: 'js', js: 'js', jsx: 'js', mjs: 'js', cjs: 'js',
    proto: 'proto', ex: 'ex', exs: 'ex', yaml: 'yaml', yml: 'yaml',
    sh: 'sh', sql: 'sql', json: 'json', jsonc: 'json', mod: 'go', graphql: 'proto', toml: 'yaml',
  };
  const hlReCache = new Map();
  function hlRe(lang) {
    if (hlReCache.has(lang)) return hlReCache.get(lang);
    const cfg = HL_LANGS[lang];
    const parts = [
      cfg.block ? '(\\/\\*)' : '([^\\s\\S])', // 1: ブロックコメント開始([^\s\S] = 決してマッチしない)
      cfg.line ? `(${cfg.line.replace(/[/*-]/g, '\\$&')}.*$)` : '([^\\s\\S])', // 2: 行コメント
      `("(?:[^"\\\\]|\\\\.)*"?|'(?:[^'\\\\]|\\\\.)*'?|\`[^\`]*\`?)`, // 3: 文字列
      `\\b(${cfg.kw})\\b`, // 4: キーワード
      '\\b(\\d[\\d_]*(?:\\.\\d+)?)\\b', // 5: 数値
      '\\b([A-Za-z_]\\w*)(?=\\s*\\()', // 6: 関数呼び出し/定義名
    ];
    const re = new RegExp(parts.join('|'), lang === 'sql' ? 'gmi' : 'gm');
    hlReCache.set(lang, re);
    return re;
  }
  // 1 行をハイライトして HTML を返す。st.inBlock でブロックコメント状態を持ち越す
  function hlLine(line, lang, st) {
    if (!lang || !HL_LANGS[lang]) return esc(line) || ' ';
    let out = '';
    let rest = line;
    if (st.inBlock) {
      const end = rest.indexOf('*/');
      if (end === -1) return `<span class="tok-c">${esc(rest)}</span>` || ' ';
      out += `<span class="tok-c">${esc(rest.slice(0, end + 2))}</span>`;
      st.inBlock = false;
      rest = rest.slice(end + 2);
    }
    const re = hlRe(lang);
    re.lastIndex = 0;
    let pos = 0;
    for (let m = re.exec(rest); m; m = re.exec(rest)) {
      out += esc(rest.slice(pos, m.index));
      if (m[1] !== undefined) {
        // ブロックコメント: 同一行で閉じるか調べる
        const close = rest.indexOf('*/', m.index + 2);
        if (close === -1) {
          out += `<span class="tok-c">${esc(rest.slice(m.index))}</span>`;
          st.inBlock = true;
          pos = rest.length;
          break;
        }
        out += `<span class="tok-c">${esc(rest.slice(m.index, close + 2))}</span>`;
        pos = close + 2;
        re.lastIndex = pos;
        continue;
      }
      let cls =
        m[2] !== undefined
          ? 'tok-c'
          : m[3] !== undefined
            ? 'tok-s'
            : m[4] !== undefined
              ? 'tok-k'
              : m[5] !== undefined
                ? 'tok-n'
                : 'tok-f';
      // 定義がインデックスにある関数トークンだけ「飛べる」印(点線下線 + ⌘クリック)を付ける。
      // Invoke 等のライブラリ関数は定義が無いので装飾しない(誤って押せる見た目を防ぐ)
      if (cls === 'tok-f' && funcDefIndex.has(m[0])) cls = 'tok-f def';
      out += `<span class="${cls}">${esc(m[0])}</span>`;
      pos = m.index + m[0].length;
    }
    out += esc(rest.slice(pos));
    return out || ' ';
  }

  async function openSourceFile(rel, lineNo, linkHtml = '', opts = {}) {
    // 「戻る」用の履歴(同じ場所への再表示は積まない)
    if (!opts.noHistory && srcState.file && (srcState.file !== rel || srcState.line !== lineNo)) {
      srcState.history.push({ file: srcState.file, line: srcState.line, link: srcState.link });
      if (srcState.history.length > 50) srcState.history.shift();
    }
    srcState.file = rel;
    srcState.line = lineNo;
    srcState.link = linkHtml;
    // ツリー上で今のファイルまでの祖先を展開しておく
    let cur = '';
    for (const seg of rel.split('/').slice(0, -1)) {
      cur = cur === '' ? seg : cur + '/' + seg;
      srcState.treeExpanded.add(cur);
    }
    await renderSrcPanel(true);
  }

  async function renderSrcPanel(scrollToLine = false) {
    const rel = srcState.file;
    const lineNo = srcState.line;
    if (!rel) {
      apiSrcEl.classList.add('hidden');
      return;
    }
    const treeBtn = IS_STATIC
      ? ''
      : `<button class="treebtn${srcState.treeVisible ? ' active' : ''}" title="ファイルツリーを開閉">📁</button>`;
    const backBtn = `<button class="navback" title="参照元に戻る"${srcState.history.length > 0 ? '' : ' disabled'}>←</button>`;
    const blameBtn = IS_STATIC
      ? ''
      : `<button class="blamebtn${srcState.blameVisible ? ' active' : ''}" title="git blame(各行の最終変更コミット)。チップをクリックでコミット・PR・diff を表示">⎇ blame</button>`;
    const head =
      `<div class="srchead">` +
      backBtn +
      treeBtn +
      blameBtn +
      `<span class="fname" data-full="${esc(rel)}${lineNo ? ':' + lineNo : ''}">${esc(rel)}${lineNo ? ':' + lineNo : ''}</span>` +
      srcState.link.replace(/>([^<]*)<\/a>/, ' title="エディタで開く">エディタ</a>') +
      `<span class="srchint">⌘クリック = 定義へ</span>` +
      `<button class="close" title="閉じる">✕</button></div>`;
    apiSrcEl.classList.remove('hidden');
    if (IS_STATIC) {
      apiSrcEl.innerHTML =
        head +
        `<div class="srcmsg">エクスポートされた HTML ではソース表示は使えません。<br>` +
        `<code>strata serve</code> で起動すると、ここに実際のコードが表示されます。</div>`;
      return;
    }
    // 取得を待つ間、前のファイルのコードを出したままにしない(別ファイルを開いたつもりで
    // 前のコードを読んでしまう)。ヘッダーだけ先に描いて本文を読み込み中にする
    const token = ++srcState.renderSeq;
    apiSrcEl.innerHTML = head + `<div class="srcbody">` + loadingHtml('ソースを読み込んでいます…') + `</div>`;
    let blame = null;
    let blameNote = '';
    if (srcState.blameVisible && !IS_STATIC) {
      blame = await fetchBlame(rel);
      if (blame.error) {
        blameNote = `<div class="srcmsg blnote">⎇ ${esc(blame.error)}</div>`;
        blame = null;
      }
    }
    let codeHtml;
    try {
      const content = await fetchSource(rel);
      const lines = content.split('\n');
      const ext = rel.slice(rel.lastIndexOf('.') + 1).toLowerCase();
      const lang = HL_EXT[ext];
      const hlState = { inBlock: false };
      const parts = [];
      let prevSha = null;
      for (let i = 0; i < lines.length; i++) {
        const hl = lineNo !== null && i + 1 === lineNo ? ' hl' : '';
        // blame ガター: 同一コミットのブロック先頭にだけチップを出す
        let gutter = '';
        if (blame) {
          const info = blame.byLine.get(i + 1);
          if (info && info.sha !== prevSha) {
            const age = blameAge(info.time);
            gutter =
              `<span class="bl ${age.cls}" data-sha="${esc(info.sha)}" ` +
              `title="${esc(info.author)} ・ ${esc(info.summary)}(クリックで diff / PR)">` +
              `${esc(info.sha.slice(0, 7))} ${age.label}</span>`;
          } else {
            gutter = '<span class="bl"></span>';
          }
          prevSha = info ? info.sha : null;
        }
        parts.push(
          `<div class="cl${hl}" id="L${i + 1}"><span class="ln">${i + 1}</span>${gutter}<span>${hlLine(lines[i], lang, hlState)}</span></div>`,
        );
      }
      codeHtml = blameNote + `<pre class="code">${parts.join('')}</pre>`;
    } catch (err) {
      codeHtml = `<div class="srcmsg">読み込めませんでした: ${esc(String(err))}</div>`;
    }
    let treeHtml = '';
    if (srcState.treeVisible) {
      let files = [];
      try {
        if (srcState.filesPromise === null && token === srcState.renderSeq) {
          // 初回はワークスペース全体を歩くので待たせる。枠だけ先に出す
          // (追い越されていたら書かない — 新しく開いたファイルの表示を潰してしまう)
          apiSrcEl.innerHTML =
            head + `<div class="srcbody"><div id="srctree">${loadingHtml('ファイル一覧を読み込んでいます…')}</div>${codeHtml}</div>`;
        }
        files = await fetchFileList();
      } catch {
        // 一覧が取れなくてもコード表示は続行
      }
      treeHtml =
        `<div id="srctree">` +
        `<input id="srctree-filter" type="search" placeholder="ファイル名で絞り込み…" value="${esc(srcState.treeFilter)}">` +
        `<div class="tlist">${treeListHtml(files)}</div>` +
        `</div>`;
    }
    if (token !== srcState.renderSeq) return; // 次の描画に追い越されたので捨てる
    apiSrcEl.innerHTML = head + `<div class="srcbody">` + treeHtml + codeHtml + `</div>`;
    if (scrollToLine && lineNo !== null) {
      const target = apiSrcEl.querySelector('#L' + lineNo);
      if (target) target.scrollIntoView({ block: 'center' });
    }
  }

  function renderApi() {
    renderApiList();
    renderApiFlow();
  }

  function setTab(tab) {
    state.tab = tab;
    document.body.classList.toggle('tab-api', tab === 'api');
    document.body.classList.toggle('tab-projects', tab === 'projects');
    document.body.classList.toggle('tab-entries', tab === 'entries');
    document.body.classList.toggle('tab-diagram', tab === 'diagram');
    document.body.classList.toggle('tab-diff', tab === 'diff');
    $('#tab-structure').classList.toggle('active', tab === 'structure');
    $('#tab-api').classList.toggle('active', tab === 'api');
    $('#tab-entries').classList.toggle('active', tab === 'entries');
    $('#tab-diagram').classList.toggle('active', tab === 'diagram');
    $('#tab-diff').classList.toggle('active', tab === 'diff');
    $('#tab-projects').classList.toggle('active', tab === 'projects');
    mainEl.classList.toggle('hidden', tab !== 'structure');
    apiViewEl.classList.toggle('hidden', tab !== 'api');
    entriesViewEl.classList.toggle('hidden', tab !== 'entries');
    diagramViewEl.classList.toggle('hidden', tab !== 'diagram');
    diffViewEl.classList.toggle('hidden', tab !== 'diff');
    projViewEl.classList.toggle('hidden', tab !== 'projects');
    if (tab === 'api') {
      sideEl.classList.add('hidden');
      renderApi();
    } else if (tab === 'entries') {
      sideEl.classList.add('hidden');
      renderEntries();
    } else if (tab === 'diagram') {
      sideEl.classList.add('hidden');
      renderDiagram();
    } else if (tab === 'diff') {
      sideEl.classList.add('hidden');
      renderDiff();
      // ディープリンク(#diff)で直接開かれた場合もここで ref 一覧を取りにいく
      if (!diffState.refs && !IS_STATIC) loadDiffRefs();
    } else if (tab === 'projects') {
      sideEl.classList.add('hidden');
      renderProjects();
    } else {
      render(); // renderSide が sideMode に応じて side を復元する
    }
    syncHash();
  }

  // 共有用ディープリンク: #api(カタログ) / #api=<RPC ID>(フローまで開く)
  function syncHash() {
    if (typeof location === 'undefined') return;
    if (state.tab === 'api') {
      const h = state.apiRpc ? 'api=' + encodeURIComponent(state.apiRpc) : 'api';
      history.replaceState(null, '', '#' + h);
    } else if (state.tab === 'projects') {
      history.replaceState(null, '', '#projects');
    } else if (state.tab === 'entries') {
      history.replaceState(null, '', '#entries');
    } else if (state.tab === 'diagram') {
      history.replaceState(null, '', '#diagram');
    } else if (state.tab === 'diff') {
      history.replaceState(null, '', '#diff');
    } else if (state.tab === 'structure') {
      // 構造ビューの焦点・検索・並びを URL に反映(リロード復元・共有用)
      const parts = [];
      if (state.focus) parts.push('node=' + encodeURIComponent(state.focus));
      if (state.q) parts.push('q=' + encodeURIComponent(state.q));
      if (state.sort && state.sort !== 'level') parts.push('sort=' + encodeURIComponent(state.sort));
      if (parts.length) history.replaceState(null, '', '#' + parts.join('&'));
      else if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    }
  }
  function applyHash() {
    if (typeof location === 'undefined') return;
    const raw = location.hash.slice(1);
    if (!raw) return;
    if (raw === 'projects' || raw === 'entries' || raw === 'diagram' || raw === 'diff') {
      setTab(raw);
      return;
    }
    const params = new URLSearchParams(raw);
    if (raw === 'api' || params.has('api')) {
      const rpc = params.get('api');
      if (rpc && byId.has(rpc)) {
        state.apiRpc = rpc;
        state.apiSel = rpc;
      }
      setTab('api');
      if (state.apiRpc) openSource(state.apiRpc);
      return;
    }
    // 構造ビューの状態を復元
    if (params.has('node') || params.has('q') || params.has('sort')) {
      const q = params.get('q');
      if (q) {
        state.q = q;
        const searchEl = $('#search');
        if (searchEl) searchEl.value = q;
      }
      const sort = params.get('sort');
      if (sort) {
        state.sort = sort;
        const sortEl = $('#sort');
        if (sortEl) sortEl.value = sort;
      }
      setTab('structure');
      const node = params.get('node');
      if (node && byId.has(node)) {
        setFocus(node);
        scrollToRow(node);
      } else {
        render();
      }
    }
  }

  // スクロール中はフィルタを自動で最小化(集計行のみ)。
  // ▾フィルタ をクリックすると一時的に展開(ピン)し、さらにスクロールすると再び最小化する。
  const apiHeadState = { pinned: false, pinnedAt: 0 };
  function updateApiHeadMin() {
    const head = apiListEl.querySelector('.apihead');
    if (!head || !head.classList) return;
    const st = apiListEl.scrollTop || 0;
    if (apiHeadState.pinned && Math.abs(st - apiHeadState.pinnedAt) > 60) apiHeadState.pinned = false;
    const min = st > 40 && !apiHeadState.pinned && !state.apiFilterCollapsed;
    head.classList.toggle('minimized', min);
  }
  apiListEl.addEventListener('scroll', updateApiHeadMin);

  apiListEl.addEventListener('click', (ev) => {
    const unres = ev.target.closest('.unres-item.jump');
    if (unres) {
      openSourceFile(unres.dataset.unresFile, Number(unres.dataset.unresLine) || 1);
      return;
    }
    const ftog = ev.target.closest('[data-ftoggle]');
    if (ftog) {
      // スクロールで自動最小化されている場合は、まず展開(ピン)するだけ
      const head = apiListEl.querySelector('.apihead');
      if (head && head.classList && head.classList.contains('minimized')) {
        apiHeadState.pinned = true;
        apiHeadState.pinnedAt = apiListEl.scrollTop || 0;
        updateApiHeadMin();
        return;
      }
      state.apiFilterCollapsed = !state.apiFilterCollapsed;
      persistSearchFilters();
      renderApiList();
      return;
    }
    const exclEl = ev.target.closest('[data-chip-excl]');
    if (exclEl) {
      if (exclEl.dataset.chipExcl === 'used') {
        state.apiUsedOnly = !state.apiUsedOnly;
      } else if (exclEl.dataset.chipExcl === 'mocks') {
        state.apiExcludeMocks = !state.apiExcludeMocks;
      } else {
        state.apiExcludeTests = !state.apiExcludeTests;
        if (state.apiExcludeTests) state.apiUsage.delete('testonly'); // 無視中は「テストのみ」は無意味
      }
      renderApi();
      return;
    }
    const chipEl = ev.target.closest('[data-chip]');
    if (chipEl) {
      const key = chipEl.dataset.chip;
      const map = key === 'called' || key === 'testonly' || key === 'dead' ? state.apiUsage : state.apiAttrs;
      const cur = map.get(key);
      if (cur === undefined) map.set(key, 'inc');
      else if (cur === 'inc') map.set(key, 'exc');
      else map.delete(key);
      renderApiList();
      return;
    }
    const pfAll = ev.target.closest('[data-pfall]');
    if (pfAll) {
      state.apiCollapsed =
        pfAll.dataset.pfall === 'collapse'
          ? new Set([...protoNodes.map((p) => p.id), SURFACE_HTTP_ID, SURFACE_GQL_ID])
          : new Set();
      renderApiList();
      return;
    }
    const pfTw = ev.target.closest('[data-pf]');
    if (pfTw) {
      const id = pfTw.dataset.pf;
      if (state.apiCollapsed.has(id)) state.apiCollapsed.delete(id);
      else state.apiCollapsed.add(id);
      renderApiList();
      return;
    }
    const rpcItem = ev.target.closest('[data-rpc]');
    if (rpcItem) {
      state.apiRpc = rpcItem.dataset.rpc;
      state.apiSel = state.apiRpc;
      renderApi();
      openSource(state.apiRpc);
      syncHash();
      return;
    }
    const pf = ev.target.closest('[data-proto]');
    if (pf) {
      state.apiSel = pf.dataset.proto;
      openSource(pf.dataset.proto);
    }
  });
  apiListEl.addEventListener('change', (ev) => {
    const t = ev.target;
    if (!t || t.id !== 'api-sort') return;
    state.apiSort = t.value;
    renderApiList();
  });
  bindCombos(apiListEl, (key, value) => {
    if (key === 'svc') state.apiSvcFilter = value;
    else if (key === 'caller') state.apiCallerFilter = value;
    renderApiList();
  });
  apiFlowEl.addEventListener('click', (ev) => {
    const srcItem = ev.target.closest('[data-srcfile]');
    if (srcItem) {
      openSourceFile(srcItem.dataset.srcfile, srcItem.dataset.srcline ? Number(srcItem.dataset.srcline) : null);
      return;
    }
    const row = ev.target.closest('[data-flow]');
    if (!row) return;
    state.apiSel = row.dataset.flow;
    renderApiFlow();
    openSource(state.apiSel);
  });
  bindDefPeek(apiSrcEl);
  apiSrcEl.addEventListener('click', (ev) => {
    if (ev.target.closest('.close')) {
      apiSrcEl.classList.add('hidden');
      return;
    }
    if (ev.target.closest('.navback')) {
      const prev = srcState.history.pop();
      if (prev) openSourceFile(prev.file, prev.line, prev.link, { noHistory: true });
      return;
    }
    // ⌘(Ctrl)+クリック: クリック位置の識別子から関数定義へジャンプ
    if ((ev.metaKey || ev.ctrlKey) && ev.target.closest('.code')) {
      const word = wordAtPoint(ev);
      if (word) jumpToDefinition(word);
      return;
    }
    if (ev.target.closest('.treebtn')) {
      srcState.treeVisible = !srcState.treeVisible;
      renderSrcPanel();
      return;
    }
    if (ev.target.closest('.blamebtn')) {
      srcState.blameVisible = !srcState.blameVisible;
      renderSrcPanel();
      return;
    }
    const blChip = ev.target.closest('[data-sha]');
    if (blChip) {
      openCommitModal(blChip.dataset.sha, srcState.file);
      return;
    }
    const dirEl = ev.target.closest('[data-tree-dir]');
    if (dirEl) {
      const d = dirEl.dataset.treeDir;
      if (srcState.treeExpanded.has(d)) srcState.treeExpanded.delete(d);
      else srcState.treeExpanded.add(d);
      renderSrcPanel();
      return;
    }
    const fileEl = ev.target.closest('[data-tree-file]');
    if (fileEl) openSourceFile(fileEl.dataset.treeFile, null);
  });
  apiSrcEl.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'srctree-filter') {
      // 入力のフォーカスを保つため、一覧部分だけを差し替える
      srcState.treeFilter = ev.target.value.trim();
      fetchFileList()
        .then((files) => {
          const tl = apiSrcEl.querySelector('#srctree .tlist');
          if (tl) tl.innerHTML = treeListHtml(files);
        })
        .catch(() => {});
    }
  });
  $('#tab-structure').addEventListener('click', () => setTab('structure'));
  $('#tab-api').addEventListener('click', () => setTab('api'));

  // ---------- アーキテクチャ図タブ(箱と矢印・レイヤー帯) ----------
  const diagramViewEl = $('#diagramview');

  /** サービス(トップレベル)単位のグラフ。RPC への依存は実装サービスに帰属させる。 */
  function computeServiceGraph() {
    const implTopOf = (rpcId) => {
      const impls = rpcImpls.get(rpcId);
      return impls && impls.size > 0 ? chain([...impls][0])[0] : null;
    };
    const targetTop = (toId) => {
      const node = byId.get(toId);
      if (node && node.kind === 'rpc') {
        const t = implTopOf(toId);
        if (t) return t;
      } else if (node && node.kind === 'proto') {
        for (const kid of childrenOf.get(toId) || []) {
          const t = implTopOf(kid);
          if (t) return t;
        }
      }
      return chain(toId)[0];
    };
    const tops = (childrenOf.get('') || []).filter((id) => !state.structHidden.has(id));
    const topSet = new Set(tops);
    const edgeMap = new Map();
    for (const e of model.edges) {
      if (e.kind === 'impl') continue;
      const a = chain(e.from)[0];
      const b = targetTop(e.to);
      if (a === b || !topSet.has(a) || !topSet.has(b)) continue;
      const key = a + '\u0000' + b;
      const cur = edgeMap.get(key) || { from: a, to: b, rpc: 0, http: 0, gql: 0, code: 0, viol: 0, edges: 0, rules: new Set() };
      if (e.kind === 'rpc' || e.kind === 'proto') cur.rpc += e.count;
      else if (e.kind === 'http') cur.http += e.count;
      else if (e.kind === 'graphql') cur.gql += e.count;
      else cur.code += e.count;
      cur.edges++;
      // 1 本の線は多数のエッジをまとめている。全部が違反とは限らないので本数で持つ
      if (e.violates) {
        cur.viol++;
        cur.rules.add(e.violates);
      }
      edgeMap.set(key, cur);
    }
    return { tops, edges: [...edgeMap.values()] };
  }

  // 入次数がこれ以上のノードは「共有ハブ」とみなし、入ってくる線を既定で畳む。
  // 全員が依存する proto カタログに 30 本以上が集まると、画面の下半分が線の壁になる
  const DG_HUB_MIN = 12;

  const DG_LANGS = [['go', 'Go'], ['ts', 'TS / JS'], ['py', 'Python'], ['ex', 'Elixir']];

  /** ツールバーに出す「選択中の API」。絞り込みで 1 件も出ないときも、選択中であることは見せる。 */
  function dgApiChip() {
    if (state.dgApi === null || !byId.has(state.dgApi)) return null;
    return { label: (byId.get(state.dgApi) || {}).label || state.dgApi, callers: 0, visible: false };
  }

  /** 図タブのヘッダー(凡例 + 絞り込み + ズーム)。ノードが 0 件の案内でも同じものを出す。 */
  function dgToolbar(isolatedCount, langs, hubCount, violCount, api) {
    const on = (flag) => (flag ? ' on' : '');
    const legend = DG_LANGS.filter(([code]) => langs.has(code))
      .map(([code, name]) => `<span class="dg-lg lang-${code}"><i></i>${name}</span>`)
      .join('');
    return (
      `<span class="dg-legend">${legend}` +
        (hubCount > 0
          ? `<span class="dg-lg hub" title="入次数が ${DG_HUB_MIN} 以上のサービス。入ってくる線は畳んであり、ホバーか選択で開きます"><i></i>共有ハブ ${hubCount}</span>`
          : '') +
        (violCount > 0
          ? `<span class="dg-lg viol" title="strata.config.json の forbidden ルールに一致した依存。線にカーソルを合わせるとルール名と本数が出ます。完全な一覧は strata check"><i></i>禁止依存 ${violCount}</span>`
          : '') +
        `<span class="dg-lg" title="そのサービスから下へ伸びる依存チェーンの長さ(強連結成分に潰したうえでの最長路)です。0 は何にも依存しない土台側。宣言されたアーキテクチャ層ではありません"><i class="none"></i>帯 = 依存の深さ</span>` +
      `</span>` +
      `<span class="dg-tools">` +
        (api
          ? `<button id="dg-apiclear" class="dg-tog on" title="この API の強調を解除する">` +
            `⚡ ${esc(api.label)}（${api.visible ? `呼び出し元 ${api.callers}` : '表示中のサービスに該当なし'}）✕</button>`
          : '') +
        `<input id="dg-q" class="dg-search" type="search" placeholder="サービス名で絞り込み" value="${esc(state.dgQ)}">` +
        `<button id="dg-hop" class="dg-tog${on(state.dgHop)}" title="選択したサービスと、その直接の依存だけを表示する">1 ホップ</button>` +
        `<button id="dg-api" class="dg-tog${on(state.dgApiOnly)}" title="公開 API(RPC / HTTP / GraphQL)を持つサービスだけを表示する">API のみ</button>` +
        (isolatedCount > 0
          ? `<button id="dg-iso" class="dg-tog${on(state.dgIsolated)}" title="どのサービスとも繋がらないものを表示する">独立 ${isolatedCount}</button>`
          : '') +
        `<button id="dg-out" class="dg-zoom" title="縮小">−</button>` +
        `<button id="dg-in" class="dg-zoom" title="拡大">＋</button>` +
        `<button id="dg-fit" class="dg-zoom">全体を表示</button>` +
      `</span>`
    );
  }

  function renderDiagram() {
    let { tops, edges } = computeServiceGraph();
    if (tops.length === 0) {
      diagramViewEl.innerHTML = '<div class="projwrap"><div class="sub">表示できるサービスがありません</div></div>';
      return;
    }
    const labelOf = (id) => (byId.get(id) ? byId.get(id).label : id);

    // 公開エンドポイント数(⚡RPC / ⇄HTTP / ◈GraphQL)。絞り込みの判定にも使うので先に数える
    const rpcCount = new Map();
    const routeCount = new Map();
    const gqlCount = new Map();
    for (const n of model.nodes) {
      if (n.kind === 'rpc') {
        const impls = rpcImpls.get(n.id);
        const owner = impls && impls.size > 0 ? chain([...impls][0])[0] : chain(n.id)[0];
        rpcCount.set(owner, (rpcCount.get(owner) || 0) + 1);
      } else if (n.kind === 'route' && !(n.meta && n.meta.external)) {
        const owner = chain(n.id)[0];
        routeCount.set(owner, (routeCount.get(owner) || 0) + 1);
      } else if (n.kind === 'gqlfield') {
        const owner = chain(n.id)[0];
        gqlCount.set(owner, (gqlCount.get(owner) || 0) + 1);
      }
    }
    const apiCount = (id) => (rpcCount.get(id) || 0) + (routeCount.get(id) || 0) + (gqlCount.get(id) || 0);

    // 「孤立」は絞り込み前のグラフで決める。絞り込みで相手が消えたノードまで孤立扱いにすると、
    // 「API のみ」が「API 同士が直接繋がっているものだけ」になり、条件を満たすノードごと消える
    const linkedBase = new Set();
    for (const e of edges) {
      linkedBase.add(e.from);
      linkedBase.add(e.to);
    }

    // 表示するノードを絞る。選択中のノードは絞り込みでも落とさない(見失うため)
    const restrict = (keep) => {
      tops = tops.filter((id) => keep(id) || id === state.focus);
      const set = new Set(tops);
      edges = edges.filter((e) => set.has(e.from) && set.has(e.to));
    };
    if (state.dgHop && state.focus !== null && tops.includes(state.focus)) {
      const near = new Set([state.focus]);
      for (const e of edges) {
        if (e.from === state.focus) near.add(e.to);
        if (e.to === state.focus) near.add(e.from);
      }
      restrict((id) => near.has(id));
    }
    if (state.dgApiOnly) restrict((id) => apiCount(id) > 0);

    // 孤立ノード(元のグラフでどこにも繋がらないもの)は既定で畳む。
    // 数が多いと本題の依存関係が画面から押し出される。選択中のノードは畳まない
    const isolated = tops
      .filter((id) => !linkedBase.has(id) && id !== state.focus)
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b)));
    const isolatedSet = new Set(isolated);
    if (!state.dgIsolated) tops = tops.filter((id) => !isolatedSet.has(id));

    if (tops.length === 0) {
      diagramViewEl.innerHTML =
        `<div class="dg-hint">${dgToolbar(isolated.length, new Set(), 0, 0, dgApiChip())}</div>` +
        `<div class="projwrap"><div class="sub">絞り込みの条件に合うサービスがありません。上の絞り込みを外してください</div></div>`;
      return;
    }

    // レベル付け(依存される側が下)
    const adj = new Map();
    for (const e of edges) {
      if (!adj.has(e.from)) adj.set(e.from, []);
      adj.get(e.from).push(e.to);
    }
    const comps = tarjan(tops, adj);
    const compOf = new Map();
    comps.forEach((c, i) => c.forEach((id) => compOf.set(id, i)));
    const compAdj = comps.map(() => new Set());
    for (const e of edges) {
      const a = compOf.get(e.from);
      const b = compOf.get(e.to);
      if (a !== undefined && b !== undefined && a !== b) compAdj[a].add(b);
    }
    const levels = new Array(comps.length).fill(-1);
    const lvlOf = (i) => {
      if (levels[i] >= 0) return levels[i];
      levels[i] = 0;
      let m = 0;
      for (const d of compAdj[i]) m = Math.max(m, lvlOf(d) + 1);
      levels[i] = m;
      return m;
    };
    comps.forEach((_, i) => lvlOf(i));
    const nodeLevel = new Map();
    for (const id of tops) nodeLevel.set(id, levels[compOf.get(id)]);
    const maxLevel = Math.max(...nodeLevel.values());
    const rows = [];
    for (let L = maxLevel; L >= 0; L--) {
      const row = tops.filter((id) => nodeLevel.get(id) === L && !isolatedSet.has(id));
      if (row.length > 0) rows.push({ level: L, ids: row.sort((a, b) => labelOf(a).localeCompare(labelOf(b))) });
    }
    if (isolated.length > 0 && state.dgIsolated) rows.push({ level: null, ids: isolated });

    // 共有ハブに入ってくる線は既定で畳む(DOM には残し、ホバー・選択で開く)。
    // 選択中のノードに繋がる線は畳まない — いま見たいものを隠さない
    const inDeg = new Map();
    for (const e of edges) inDeg.set(e.to, (inDeg.get(e.to) || 0) + 1);
    const hubs = new Set([...inDeg].filter(([, n]) => n >= DG_HUB_MIN).map(([id]) => id));
    const isBundled = (e) => hubs.has(e.to) && e.viol === 0 && e.from !== state.focus && e.to !== state.focus;
    const langs = new Set(tops.map((id) => (byId.get(id) || {}).lang).filter(Boolean));

    // 右パネルで選んだ API。呼んでいるサービスと実装サービスだけを残して他を減光する
    let apiSel = null;
    if (state.dgApi !== null && byId.has(state.dgApi)) {
      const callers = new Set([...(rpcCallers.get(state.dgApi) || [])].map((c) => chain(c)[0]));
      // 実装は 1 つとは限らない(共有 contract の別実装)。全部を強調する
      const impls = new Set([...(rpcImpls.get(state.dgApi) || [])].map((i) => chain(i)[0]));
      // 実装が見つからない API は、定義(proto)の置き場所だけが手掛かり。実装とは別扱いにする
      const def = impls.size === 0 ? chain(state.dgApi)[0] : null;
      const shown = new Set(tops);
      const visible = [...callers, ...impls, ...(def === null ? [] : [def])].some((id) => shown.has(id));
      apiSel = {
        callers,
        impls,
        def,
        visible, // 絞り込みで全部消えたら減光しない(画面が真っ白に見えるだけで手掛かりが無い)
        label: (byId.get(state.dgApi) || {}).label || state.dgApi,
      };
    }
    const apiRoleOf = (id) => {
      if (apiSel === null || !apiSel.visible) return '';
      if (apiSel.callers.has(id)) return ' apicaller';
      if (apiSel.impls.has(id)) return ' apiimpl';
      return id === apiSel.def ? ' apidef' : ' apidim';
    };
    // レイアウト
    const BOXH = 54;
    const VGAP = 96;
    const HGAP = 26;
    const PADX = 112; // 帯のラベル(「依存の深さ N」)より右から箱を置く
    const PADY = 34;
    const LINEGAP = 26; // 同じ層を折り返したときの段の間隔
    // 箱の副題。幅の計算に使うのでレイアウトの前に決める
    const subOf = (id) => {
      const parts = [];
      if ((rpcCount.get(id) || 0) > 0) parts.push(`⚡${rpcCount.get(id)} RPC`);
      if ((routeCount.get(id) || 0) > 0) parts.push(`⇄${routeCount.get(id)} HTTP`);
      if ((gqlCount.get(id) || 0) > 0) parts.push(`◈${gqlCount.get(id)} GQL`);
      if (subtreeLoc(id) > 0) parts.push(`${subtreeLoc(id).toLocaleString('en-US')} loc`);
      if (hubs.has(id)) parts.push(`⇠${inDeg.get(id)} 依存元`);
      return parts.join(' ・ ');
    };
    // 見出しは 8.5px/字・副題は 6.6px/字で見積もる。副題が長い箱で文字が溢れていた
    const widthOf = (id) => Math.max(128, labelOf(id).length * 8.5 + 44, subOf(id).length * 6.6 + 30);
    // 1 行に並べきると 100 リポジトリで 15,000px を超える。画面幅で段に折り返す
    const maxRowW = Math.min(2600, Math.max(1100, diagramViewEl.clientWidth || document.body.clientWidth || 1600));
    const pos = new Map(); // id -> {x, y, w}
    const rowOf = new Map(); // id -> 層のインデックス(線の向きの判定に使う。折り返しで y が変わるため)
    // 層を段に折り返して配置し、最後の段の中心 y を返す
    function layoutRow(row, topY) {
      const lines = [];
      let cur = [];
      let x = PADX;
      for (const id of row.ids) {
        const w = widthOf(id);
        if (cur.length > 0 && x + w > maxRowW) {
          lines.push(cur);
          cur = [];
          x = PADX;
        }
        cur.push(id);
        x += w + HGAP;
      }
      if (cur.length > 0) lines.push(cur);
      lines.forEach((ids, li) => {
        let lx = PADX;
        const y = topY + li * (BOXH + LINEGAP);
        for (const id of ids) {
          const w = widthOf(id);
          pos.set(id, { x: lx + w / 2, y, w });
          lx += w + HGAP;
        }
      });
      row.lines = lines;
      return topY + (lines.length - 1) * (BOXH + LINEGAP);
    }
    // 上の行から順に配置し、barycenter(既配置の隣接ノードの平均 x)で並べ替えて交差を減らす
    let cursorY = PADY;
    for (let ri = 0; ri < rows.length; ri++) {
      const row = rows[ri];
      for (const id of row.ids) rowOf.set(id, ri);
      if (ri > 0) {
        const score = new Map();
        for (const id of row.ids) {
          const neigh = [];
          for (const e of edges) {
            if (e.from === id && pos.has(e.to)) neigh.push(pos.get(e.to).x);
            if (e.to === id && pos.has(e.from)) neigh.push(pos.get(e.from).x);
          }
          score.set(id, neigh.length > 0 ? neigh.reduce((a, b) => a + b, 0) / neigh.length : Infinity);
        }
        row.ids.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0) || labelOf(a).localeCompare(labelOf(b)));
      }
      row.top = cursorY;
      row.bottom = layoutRow(row, cursorY);
      cursorY = row.bottom + BOXH + VGAP;
    }
    const totalW = Math.max(...[...pos.values()].map((p) => p.x + p.w / 2)) + PADX;
    const totalH = cursorY - VGAP + PADY;
    // 段ごとに中央寄せ(行ではなく段。折り返した最後の段が左に寄ったままにならないように)
    rows.forEach((row) => {
      for (const ids of row.lines) {
        const right = Math.max(...ids.map((id) => pos.get(id).x + pos.get(id).w / 2));
        const offset = (totalW - PADX - right) / 2;
        for (const id of ids) pos.get(id).x += offset;
      }
    });

    const svg = [];
    svg.push(
      `<defs><marker id="darr" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 1 L9 5 L0 9 z" class="dg-mk"/></marker>` +
        `<marker id="darr-up" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="10" markerHeight="10" markerUnits="userSpaceOnUse" orient="auto"><path d="M0 1 L9 5 L0 9 z" class="dg-mk-up"/></marker></defs>`,
    );
    // レイヤー帯
    rows.forEach((row, ri) => {
      const y = row.top - 18;
      const h = row.bottom - row.top + BOXH + 44;
      svg.push(`<rect x="8" y="${y}" width="${totalW - 16}" height="${h}" rx="12" class="dg-band${ri % 2 === 1 ? ' alt' : ''}"/>`);
      // 「層」ではない — そのサービスから下へ伸びる依存チェーンの長さ(SCC に潰したうえでの最長路)。
      // 0 = 何にも依存しない土台側。宣言されたアーキテクチャ層と混同させない
      const tag = row.level === null ? '独立' : `依存の深さ ${row.level}`;
      svg.push(`<text x="20" y="${y + 24}" class="dg-lvl">${esc(tag)}</text>`);
    });
    // エッジ
    for (const e of edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const up = rowOf.get(e.to) < rowOf.get(e.from);
      let d;
      if (a.y === b.y) {
        const midY = a.y - 46;
        d = `M ${a.x} ${a.y - BOXH / 2} C ${a.x} ${midY}, ${b.x} ${midY}, ${b.x} ${b.y - BOXH / 2}`;
      } else if (b.y > a.y) {
        d = `M ${a.x} ${a.y + BOXH / 2} C ${a.x} ${a.y + BOXH / 2 + 44}, ${b.x} ${b.y - BOXH / 2 - 44}, ${b.x} ${b.y - BOXH / 2}`;
      } else {
        d = `M ${a.x} ${a.y - BOXH / 2} C ${a.x} ${a.y - BOXH / 2 - 44}, ${b.x} ${b.y + BOXH / 2 + 44}, ${b.x} ${b.y + BOXH / 2}`;
      }
      const width = Math.min(3.6, 1.1 + Math.log2(e.rpc + e.code + 1) * 0.55);
      const violNote =
        e.viol > 0 ? `\n禁止依存 ${e.viol}/${e.edges} 本(${[...e.rules].join(' / ')})` : '';
      // 選んだ API の「呼び出し元 → 実装(または定義)」の線だけを立てる
      const apiTarget = (id) => apiSel.impls.has(id) || id === apiSel.def;
      const apiEdge =
        apiSel === null || !apiSel.visible ? '' : apiSel.callers.has(e.from) && apiTarget(e.to) ? ' apihit' : ' apidim';
      const cls =
        `dg-edge${up ? ' up' : ''}${e.viol > 0 ? ' violation' : ''}` +
        `${e.rpc + e.http + e.gql > 0 ? ' rpc' : ''}${isBundled(e) ? ' bundled' : ''}${apiEdge}`;
      svg.push(
        `<path d="${d}" class="${cls}" stroke-width="${width.toFixed(1)}" data-from="${esc(e.from)}" data-to="${esc(e.to)}" marker-end="url(#${up || e.viol > 0 ? 'darr-up' : 'darr'})">` +
          `<title>${esc(labelOf(e.from))} → ${esc(labelOf(e.to))}(${[
            e.rpc > 0 ? '⚡RPC ' + e.rpc : '',
            e.http > 0 ? '⇄HTTP ' + e.http : '',
            e.gql > 0 ? '◈GraphQL ' + e.gql : '',
            e.code > 0 ? 'code ' + e.code : '',
          ].filter(Boolean).join(' ・ ')})${esc(violNote)}</title></path>`,
      );
      const boundaryLabel = [
        e.rpc > 0 ? '⚡' + e.rpc : '',
        e.http > 0 ? '⇄' + e.http : '',
        e.gql > 0 ? '◈' + e.gql : '',
      ].filter(Boolean).join(' ');
      const mx = a.x + (b.x - a.x) * 0.45;
      const my = a.y === b.y ? a.y - 50 : a.y + (b.y - a.y) * 0.45 + (up ? 8 : 0);
      if (boundaryLabel) {
        svg.push(`<text x="${mx}" y="${my}" class="dg-elabel${up ? ' up' : ''}${isBundled(e) ? ' bundled' : ''}${apiEdge}" data-from="${esc(e.from)}" data-to="${esc(e.to)}">${boundaryLabel}</text>`);
      }
    }
    // ノード
    for (const id of tops) {
      const p = pos.get(id);
      if (!p) continue;
      const n = byId.get(id) || { kind: 'module' };
      const sub = subOf(id);
      const cls =
        `dg-node k-${n.kind} lang-${n.lang || 'na'}` +
        `${id.startsWith('ext:') ? ' external' : ''}${state.focus === id ? ' focused' : ''}` +
        `${hubs.has(id) ? ' hub' : ''}${apiRoleOf(id)}`;
      svg.push(
        `<g class="${cls}" data-node="${esc(id)}">` +
          `<title>${esc(labelOf(id))}${sub ? ' — ' + esc(sub) : ''}\n` +
          `${hubs.has(id) ? '入ってくる線は畳んであります。ホバーか選択で開きます\n' : ''}` +
          `クリックすると依存元・依存先・公開 API を表示します</title>` +
          `<rect x="${p.x - p.w / 2}" y="${p.y - BOXH / 2}" width="${p.w}" height="${BOXH}" rx="10"/>` +
          `<rect class="dg-langbar" x="${p.x - p.w / 2 + 2}" y="${p.y - BOXH / 2 + 9}" width="3" height="${BOXH - 18}" rx="1.5"/>` +
          `<text x="${p.x}" y="${p.y - 4}" class="dg-label">${esc(labelOf(id))}</text>` +
          `<text x="${p.x}" y="${p.y + 15}" class="dg-sub">${esc(sub)}</text>` +
          `</g>`,
      );
    }
    dgExtent = { w: totalW, h: totalH };
    dgLayoutWidth = maxRowW;
    dgView = null; // 再描画したら表示位置は全体に戻す
    diagramViewEl.innerHTML =
      `<div class="dg-hint" title="クリック = 詳細パネル(依存・公開API・経路探索) ・ ホバー = 関連する線を強調 ・ 右クリック = そのサービスを非表示 ・ ⌘/Ctrl + ホイールかキーボード(← ↑ → ↓ / + − 0)で拡大縮小">` +
        dgToolbar(
          isolated.length,
          langs,
          hubs.size,
          edges.filter((e) => e.viol > 0).length,
          apiSel === null ? null : { label: apiSel.label, callers: apiSel.callers.size, visible: apiSel.visible },
        ) +
      `</div>` +
      `<div class="dg-scroll"><svg id="dg-svg" xmlns="http://www.w3.org/2000/svg" tabindex="0" role="group" aria-label="アーキテクチャ図(矢印キーで移動、+ − で拡大縮小、0 で全体表示)" preserveAspectRatio="xMidYMid meet" viewBox="0 0 ${totalW} ${totalH}">${svg.join('')}</svg></div>`;
    dgApplyView();
    dgHideOverlappingLabels();
    dgApplyQuery();
  }

  /**
   * 絞り込み文字列に一致しない箱を減光する。
   * 入力のたびに組み直すと拡大位置と入力フォーカスを失うので、クラスの付け替えだけで済ませる。
   */
  function dgApplyQuery() {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl) return;
    const q = state.dgQ.trim().toLowerCase();
    for (const g of svgEl.querySelectorAll('.dg-node')) {
      const node = byId.get(g.dataset.node);
      const label = ((node && node.label) || g.dataset.node).toLowerCase();
      g.classList.toggle('dim', q !== '' && !label.includes(q));
    }
    svgEl.classList.toggle('filtered', q !== '');
  }

  /**
   * 重なる境界ラベルを隠す。密なグラフでは字が潰れて読めない塊になるため。
   * 幅を見積もると記号の描画差で外すので、描画後の実測(getBBox)で判定する。
   * 隠しても件数は線の <title> とホバー時の強調で辿れる。
   */
  function dgHideOverlappingLabels() {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl) return;
    const placed = [];
    for (const el of svgEl.querySelectorAll('.dg-elabel')) {
      if (typeof el.getBBox !== 'function') return;
      const b = el.getBBox();
      if (b.width === 0) continue;
      const right = b.x + b.width;
      const bottom = b.y + b.height;
      if (placed.some((p) => b.x < p.x + p.w && p.x < right && b.y < p.y + p.h && p.y < bottom)) {
        el.classList.add('hidden');
      } else {
        placed.push({ x: b.x, y: b.y, w: b.width, h: b.height });
      }
    }
  }

  // 図の表示範囲(viewBox)。null = 全体表示。再描画のたびに作り直すので描画側には持たせない
  let dgExtent = { w: 1, h: 1 };
  let dgView = null;
  let dgLayoutWidth = 0; // 折り返しに使った幅。リサイズで組み直すかの判断に使う

  /** 全体表示のときの viewBox。内容が画面より小さければ等倍にする(引き伸ばして文字を太らせない)。 */
  function dgBaseView(svgEl) {
    const r = svgEl.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && dgExtent.w <= r.width && dgExtent.h <= r.height) {
      return { x: -(r.width - dgExtent.w) / 2, y: -(r.height - dgExtent.h) / 2, w: r.width, h: r.height };
    }
    return { x: 0, y: 0, w: dgExtent.w, h: dgExtent.h };
  }

  function dgApplyView() {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl) return;
    const v = dgView ?? dgBaseView(svgEl);
    svgEl.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
    svgEl.classList.toggle('zoomed', dgView !== null);
  }

  let dgResizeTimer = null;
  if (typeof window.addEventListener === 'function') {
    window.addEventListener('resize', () => {
      if (state.tab !== 'diagram') return;
      clearTimeout(dgResizeTimer);
      dgResizeTimer = setTimeout(() => {
        // 折り返し幅が変わるほど広がった/狭まったときだけ組み直す(拡大中の位置を無駄に捨てない)
        const w = Math.min(2600, Math.max(1100, diagramViewEl.clientWidth || 1600));
        if (Math.abs(w - dgLayoutWidth) > 80) renderDiagram();
        else if (dgView === null) dgApplyView();
      }, 150);
    });
  }

  /** 画面上の 1px が viewBox 何単位か。preserveAspectRatio="meet" なので長辺側の比が効く。 */
  function dgUnitsPerPixel(svgEl, v) {
    const r = svgEl.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return 1;
    return Math.max(v.w / r.width, v.h / r.height);
  }

  /** 画面座標(省略時は中央)を固定して拡大縮小する。scale < 1 で寄る。 */
  function dgZoomAt(scale, clientX, clientY) {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl) return;
    const base = dgBaseView(svgEl);
    const v = dgView ?? base;
    // 全体より広げない・40 倍より寄らない
    const nw = Math.min(base.w, Math.max(base.w / 40, v.w * scale));
    const nh = (v.h / v.w) * nw;
    const r = svgEl.getBoundingClientRect();
    const u = dgUnitsPerPixel(svgEl, v);
    // 余白(letterbox)を除いた描画領域の左上を求め、その点を固定して寄る
    const cx = clientX === undefined ? r.left + r.width / 2 : clientX;
    const cy = clientY === undefined ? r.top + r.height / 2 : clientY;
    const ax = v.x + (cx - (r.left + (r.width - v.w / u) / 2)) * u;
    const ay = v.y + (cy - (r.top + (r.height - v.h / u) / 2)) * u;
    dgView = { x: ax - (ax - v.x) * (nw / v.w), y: ay - (ay - v.y) * (nh / v.h), w: nw, h: nh };
    if (dgView.w >= base.w) dgView = null;
    dgApplyView();
  }

  /** 表示範囲の割合で移動する(キーボード用)。全体表示のときは動かさない。 */
  function dgPan(dx, dy) {
    if (dgView === null) return;
    dgView = { ...dgView, x: dgView.x + dgView.w * dx, y: dgView.y + dgView.h * dy };
    dgApplyView();
  }

  diagramViewEl.addEventListener(
    'wheel',
    (ev) => {
      // 素のホイールはページのスクロールに残す(図の中に閉じ込めない)
      if (!ev.ctrlKey && !ev.metaKey) return;
      const svgEl = diagramViewEl.querySelector('#dg-svg');
      if (!svgEl || !svgEl.contains(ev.target)) return;
      ev.preventDefault();
      dgZoomAt(Math.exp(ev.deltaY * 0.002), ev.clientX, ev.clientY);
    },
    { passive: false },
  );

  diagramViewEl.addEventListener('input', (ev) => {
    if (ev.target.id !== 'dg-q') return;
    state.dgQ = ev.target.value;
    dgApplyQuery();
  });

  // 右クリックでそのサービスを非表示にする(構造タブの ⊘ と同じ状態。ヘッダーの「非表示 N」で戻せる)
  diagramViewEl.addEventListener('contextmenu', (ev) => {
    const g = ev.target.closest && ev.target.closest('[data-node]');
    if (!g) return;
    ev.preventDefault();
    state.structHidden.add(g.dataset.node);
    persistHidden();
    if (state.focus === g.dataset.node) state.focus = null;
    render(); // ヘッダーの「非表示 N」バッジと構造ビューを合わせる
    renderDiagram();
  });

  // ホイールもドラッグも使えない環境向け。SVG は tabindex で focus できる
  diagramViewEl.addEventListener('keydown', (ev) => {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl || ev.target !== svgEl) return;
    const STEP = 0.15;
    if (ev.key === 'ArrowLeft') dgPan(-STEP, 0);
    else if (ev.key === 'ArrowRight') dgPan(STEP, 0);
    else if (ev.key === 'ArrowUp') dgPan(0, -STEP);
    else if (ev.key === 'ArrowDown') dgPan(0, STEP);
    else if (ev.key === '+' || ev.key === '=') dgZoomAt(0.8);
    else if (ev.key === '-' || ev.key === '_') dgZoomAt(1.25);
    else if (ev.key === '0') { dgView = null; dgApplyView(); }
    else return;
    ev.preventDefault();
  });

  let dgDrag = null;
  function dgEndDrag() {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (svgEl) {
      svgEl.classList.remove('panning');
      if (dgDrag && typeof svgEl.releasePointerCapture === 'function') {
        try {
          svgEl.releasePointerCapture(dgDrag.id);
        } catch {
          // すでに解放済み(pointercancel 後など)
        }
      }
    }
    dgDrag = null;
  }
  diagramViewEl.addEventListener('pointerdown', (ev) => {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl || !svgEl.contains(ev.target) || ev.button !== 0) return;
    if (ev.target.closest && ev.target.closest('[data-node]')) return; // ノードの選択を邪魔しない
    const v = dgView ?? dgBaseView(svgEl);
    dgDrag = { id: ev.pointerId, cx: ev.clientX, cy: ev.clientY, vx: v.x, vy: v.y, u: dgUnitsPerPixel(svgEl, v), w: v.w, h: v.h };
    // 図の外へ出ても掴んだままにする(枠で切れると大きく動かせない)
    if (typeof svgEl.setPointerCapture === 'function') svgEl.setPointerCapture(ev.pointerId);
    svgEl.classList.add('panning');
  });
  diagramViewEl.addEventListener('pointermove', (ev) => {
    if (!dgDrag) return;
    if (ev.buttons === 0) return dgEndDrag(); // pointerup を取りこぼした場合の自己回復
    dgView = {
      x: dgDrag.vx - (ev.clientX - dgDrag.cx) * dgDrag.u,
      y: dgDrag.vy - (ev.clientY - dgDrag.cy) * dgDrag.u,
      w: dgDrag.w,
      h: dgDrag.h,
    };
    dgApplyView();
  });
  for (const type of ['pointerup', 'pointercancel']) diagramViewEl.addEventListener(type, dgEndDrag);
  if (typeof window.addEventListener === 'function') window.addEventListener('blur', dgEndDrag);

  diagramViewEl.addEventListener('click', (ev) => {
    if (ev.target.id === 'dg-fit') {
      dgView = null;
      dgApplyView();
      return;
    }
    if (ev.target.id === 'dg-apiclear') {
      state.dgApi = null;
      renderDiagram();
      renderSide();
      return;
    }
    if (ev.target.id === 'dg-in') return dgZoomAt(0.8);
    if (ev.target.id === 'dg-out') return dgZoomAt(1.25);
    const toggle = { 'dg-hop': 'dgHop', 'dg-api': 'dgApiOnly', 'dg-iso': 'dgIsolated' }[ev.target.id];
    if (toggle) {
      state[toggle] = !state[toggle];
      renderDiagram();
      return;
    }
    const g = ev.target.closest && ev.target.closest('[data-node]');
    if (!g) return;
    const id = g.dataset.node;
    setFocus(state.focus === id ? null : id);
  });
  diagramViewEl.addEventListener('mouseover', (ev) => {
    const g = ev.target.closest && ev.target.closest('[data-node]');
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (!svgEl) return;
    if (!g) {
      svgEl.classList.remove('hovering');
      return;
    }
    const id = g.dataset.node;
    svgEl.classList.add('hovering');
    const related = new Set([id]);
    for (const el of svgEl.querySelectorAll('.dg-edge, .dg-elabel')) {
      const hit = el.dataset.from === id || el.dataset.to === id;
      el.classList.toggle('rel', hit);
      if (hit) {
        related.add(el.dataset.from);
        related.add(el.dataset.to);
      }
    }
    for (const el of svgEl.querySelectorAll('.dg-node')) {
      el.classList.toggle('rel', related.has(el.dataset.node));
    }
  });
  diagramViewEl.addEventListener('mouseleave', () => {
    const svgEl = diagramViewEl.querySelector('#dg-svg');
    if (svgEl) svgEl.classList.remove('hovering');
  });
  $('#tab-diagram').addEventListener('click', () => setTab('diagram'));

  // ---------- エントリーポイントタブ ----------
  const entriesViewEl = $('#entriesview');

  function renderEntries() {
    const topOf = (id) => {
      const top = chain(id)[0];
      return (byId.get(top) || {}).label || top;
    };
    const srcChipOf = (n) => {
      const meta = n.meta || {};
      const f = meta.file || (n.kind === 'file' ? n.id : null);
      if (!f) return '';
      return ` <span class="fsite" data-srcfile="${esc(f)}" data-srcline="${meta.line || 1}" title="ソースを開く">${esc(f.slice(f.lastIndexOf('/') + 1))}${meta.line ? ':' + meta.line : ''}</span>`;
    };
    // プロセス起動点(func main)
    const mains = model.nodes
      .filter((n) => (n.meta || {}).entry === 'main')
      .sort((a, b) => topOf(a.id).localeCompare(topOf(b.id)));
    const mainRows = mains
      .map(
        (n) =>
          `<div class="erow" data-entry="${esc(n.id)}" title="クリックで構造ビューに移動し下流をトレース">` +
          `<span class="svcbadge">${esc(topOf(n.id))}</span> ƒ ${esc(n.label)}${srcChipOf(n)}</div>`,
      )
      .join('');
    // 画面(LiveView)+ イベント
    const views = model.nodes
      .filter((n) => (n.meta || {}).entry === 'view')
      .sort((a, b) => a.label.localeCompare(b.label));
    const viewRows = views
      .map((n) => {
        const events = ((n.meta || {}).events || [])
          .map((ev) => {
            const handler = n.id + '#handle_event';
            return `<span class="evchip" data-entry="${esc(byId.has(handler) ? handler : n.id)}" title="イベント '${esc(ev)}' のハンドラをトレース">${esc(ev)}</span>`;
          })
          .join('');
        // owner/auth_live.ex のような同名画面を区別できるよう、親ディレクトリ付きで表示
        const segs = n.id.split('/');
        const shortPath = segs.slice(-2).join('/');
        return (
          `<div class="erow" data-entry="${esc(n.id)}">` +
          `<span class="svcbadge">${esc(topOf(n.id))}</span> ▤ ${esc(shortPath)}${srcChipOf(n)}` +
          (events ? `<div class="evrow">操作: ${events}</div>` : '') +
          `</div>`
        );
      })
      .join('');
    entriesViewEl.innerHTML =
      `<div class="projwrap">` +
      `<h2>エントリーポイント</h2>` +
      `<div class="sub">「どこから読み始めるか」のカタログ。クリックすると構造ビューでそのエントリーポイントにフォーカスし、` +
      `下流(そこから何が起きるか)をトレース表示します</div>` +
      `<div class="sec">▶ プロセス起動点(func main) — ${mains.length}</div>` +
      (mainRows || '<div class="sub">検出なし</div>') +
      `<div class="sec">▤ 画面(LiveView) — ${views.length}</div>` +
      (viewRows || '<div class="sub">検出なし</div>') +
      `<div class="sec">⚡ 公開 API</div>` +
      `<div class="erow" data-goto-api="1">RPC の一覧は API タブへ(${model.nodes.filter((n) => n.kind === 'rpc').length} RPC)</div>` +
      `</div>`;
  }

  entriesViewEl.addEventListener('click', (ev) => {
    const srcChip = ev.target.closest('[data-srcfile]');
    if (srcChip) {
      setTab('api');
      openSourceFile(srcChip.dataset.srcfile, srcChip.dataset.srcline ? Number(srcChip.dataset.srcline) : null);
      return;
    }
    if (ev.target.closest('[data-goto-api]')) {
      setTab('api');
      return;
    }
    const entry = ev.target.closest('[data-entry]');
    if (entry) {
      const id = entry.dataset.entry;
      setTab('structure');
      state.focus = id;
      state.sideMode = 'info';
      state.traceDir = 'down';
      render();
      scrollToRow(id);
    }
  });
  $('#tab-entries').addEventListener('click', () => setTab('entries'));

  // ---------- 差分タブ ----------
  // 2 つの git ref を server 側で解析し、サービス依存の増減と循環の変化だけを見せる。
  // ref ごとに一時 worktree を作って丸ごと解析するので、実行には数秒かかる。
  const diffViewEl = $('#diffview');
  if (IS_STATIC) $('#tab-diff').classList.add('hidden');
  const diffState = { base: '', head: '', refs: null, result: null, error: '', busy: false };

  function diffOptions(selected, includeWorktree) {
    const refs = diffState.refs || { branches: [], tags: [] };
    const opt = (v, label) =>
      `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
    let html = includeWorktree ? opt('', '作業ツリー(未コミットを含む現在の状態)') : '';
    if (refs.branches.length) {
      html += `<optgroup label="ブランチ">${refs.branches.map((b) => opt(b, b)).join('')}</optgroup>`;
    }
    if (refs.tags.length) {
      html += `<optgroup label="タグ">${refs.tags.map((t) => opt(t, t)).join('')}</optgroup>`;
    }
    return html;
  }

  function diffSection(title, items, mark, cls) {
    if (!items || items.length === 0) return '';
    const rows = items
      .map((it) => `<li class="${cls}"><span class="dmark">${mark}</span>${esc(it)}</li>`)
      .join('');
    return `<div class="dsec"><h3>${esc(title)} <span class="dcount">${items.length}</span></h3><ul>${rows}</ul></div>`;
  }

  function diffResultHtml() {
    const d = diffState.result;
    if (!d) return '';
    const diff = d.diff;
    const quiet =
      diff.addedServiceDeps.length === 0 &&
      diff.removedServiceDeps.length === 0 &&
      diff.newCycles.length === 0 &&
      diff.resolvedCycles.length === 0;
    const prLink =
      d.pr && d.repoUrl
        ? `<a class="prlink" href="${esc(d.repoUrl)}/pull/${d.pr}" target="_blank" rel="noreferrer noopener">PR #${d.pr} を開く</a>`
        : '';
    return (
      `<div class="dsummary"><b>${esc(d.base)}</b> → <b>${esc(d.head || '作業ツリー')}</b>` +
      `<span class="sub">エッジ +${diff.addedEdgeCount} / -${diff.removedEdgeCount}</span>${prLink}</div>` +
      diffSection('⚠ 新規に発生した循環', diff.newCycles, '+', 'bad') +
      diffSection('✅ 解消された循環', diff.resolvedCycles, '-', 'good') +
      diffSection('新規サービス依存', diff.addedServiceDeps, '+', 'add') +
      diffSection('消えたサービス依存', diff.removedServiceDeps, '-', 'del') +
      (quiet ? '<div class="sub dquiet">サービス依存・循環に構造的な変化はありません</div>' : '')
    );
  }

  function renderDiff() {
    if (IS_STATIC) {
      diffViewEl.innerHTML =
        '<div class="diffwrap"><div class="sub">エクスポートされた HTML では差分比較は使えません(git が必要です)</div></div>';
      return;
    }
    if (diffState.refs === null && diffState.error === '') {
      // ref 一覧の取得中。git のブランチ数が多いと待たされる
      diffViewEl.innerHTML =
        `<div class="diffwrap"><h2>差分</h2>${loadingHtml('ブランチ・タグの一覧を読み込んでいます…')}</div>`;
      return;
    }
    if (diffState.refs && diffState.refs.git === false) {
      diffViewEl.innerHTML =
        '<div class="diffwrap"><div class="sub">このプロジェクトは git リポジトリではないため、差分比較は使えません</div></div>';
      return;
    }
    diffViewEl.innerHTML =
      `<div class="diffwrap">` +
      `<h2>差分</h2>` +
      `<div class="sub">2 つの git ref を解析して、サービス依存の増減と循環の変化を比べます。` +
      `ref ごとに一時 worktree を作るので、いま編集中のファイルには触れません</div>` +
      `<div class="drow">` +
      `<label>比較元<select id="diff-base" title="比較の基準にする ref(例: main)">${diffOptions(diffState.base, false)}</select></label>` +
      `<label>比較先<select id="diff-head" title="比較する ref。作業ツリーを選ぶと未コミットの変更も含めて比べます">${diffOptions(diffState.head, true)}</select></label>` +
      `<button id="diff-run"${diffState.busy ? ' disabled' : ''} title="2 つの ref を解析して差分を出す(数秒かかります)">${diffState.busy ? '解析中…' : '比較する'}</button>` +
      `</div>` +
      (diffState.error ? `<div class="sub derr">${esc(diffState.error)}</div>` : '') +
      (diffState.busy
        ? loadingHtml('2 つの ref を解析しています… 大きなリポジトリでは数秒かかります')
        : diffResultHtml()) +
      `</div>`;
  }

  async function loadDiffRefs() {
    try {
      const r = await fetch('refs' + projQS('?'));
      if (!r.ok) throw new Error('HTTP ' + r.status);
      diffState.refs = await r.json();
      if (!diffState.base) diffState.base = diffState.refs.head || (diffState.refs.branches || [])[0] || '';
    } catch (err) {
      diffState.error = 'ref 一覧を取得できません: ' + String(err);
    }
    renderDiff();
  }

  async function runDiff() {
    if (diffState.busy) return;
    diffState.busy = true;
    diffState.error = '';
    diffState.result = null;
    renderDiff();
    try {
      const q = new URLSearchParams({ base: diffState.base });
      if (diffState.head) q.set('head', diffState.head);
      const r = await fetch('diff?' + q.toString() + projQS('&'));
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || 'HTTP ' + r.status);
      diffState.result = data;
    } catch (err) {
      diffState.error = String((err && err.message) || err);
    } finally {
      diffState.busy = false;
      renderDiff();
    }
  }

  diffViewEl.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.id === 'diff-base') diffState.base = el.value;
    else if (el.id === 'diff-head') diffState.head = el.value;
  });
  diffViewEl.addEventListener('click', (ev) => {
    if (ev.target.closest('#diff-run')) runDiff();
  });
  $('#tab-diff').addEventListener('click', () => setTab('diff'));

  // ---------- プロジェクト管理タブ ----------
  const projViewEl = $('#projview');
  if (IS_STATIC) $('#tab-projects').classList.add('hidden');

  async function renderProjects() {
    if (IS_STATIC) {
      projViewEl.innerHTML =
        '<div class="projwrap"><div class="sub">エクスポートされた HTML ではプロジェクト管理は使えません</div></div>';
      return;
    }
    projViewEl.innerHTML = '<div class="projwrap"><div class="sub">読み込み中…</div></div>';
    let data;
    try {
      const r = await fetch('projects');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      data = await r.json();
    } catch (err) {
      projViewEl.innerHTML = `<div class="projwrap"><div class="sub">取得に失敗しました: ${esc(String(err))}</div></div>`;
      return;
    }
    const current = PROJ || data.default;
    const missing = (data.projects || []).filter((p) => !p.exists).length;
    const cards = (data.projects || [])
      .map((p) => {
        const isCur = current !== null && p.path === current;
        return (
          `<div class="pcard${isCur ? ' current' : ''}">` +
          `<div class="pinfo"><b>${esc(p.name)}</b>` +
          (isCur ? ' <span class="curbadge">表示中</span>' : '') +
          (p.composite ? ' <span class="curbadge composite">複合</span>' : '') +
          (p.exists ? '' : ' <span class="warnmark badge-dead">パスが見つかりません</span>') +
          (p.composite && p.paths
            ? `<div class="ppath">構成: ${p.paths.map((d) => esc(d)).join(' ＋ ')}</div>`
            : '') +
          `<div class="ppath">${esc(p.path)}</div></div>` +
          `<div class="pbtns">` +
          (isCur ? '' : `<button data-open="${esc(p.path)}"${p.exists ? '' : ' disabled'} title="このリポジトリを解析して表示する">開く</button>`) +
          `<button data-edit="${esc(p.path)}" title="表示名とパスを変更する(ディレクトリ自体は動きません)">編集</button>` +
          `<button class="danger" data-del="${esc(p.path)}" title="一覧から削除(ディレクトリ自体は消えません)">削除</button>` +
          `</div>` +
          `<form class="pedit hidden" data-editform="${esc(p.path)}">` +
          `<label>表示名<input type="text" name="name" value="${esc(p.name)}"></label>` +
          `<label>パス<input type="text" name="newPath" value="${esc(p.path)}"${p.composite ? ' disabled title="複合プロジェクトのパスは編集できません"' : ''}></label>` +
          `<div class="peditbtns"><button type="submit" title="表示名とパスの変更を保存する(ディレクトリ自体は動きません)">保存</button>` +
          `<button type="button" data-editcancel="1" title="編集をやめて閉じる">取消</button>` +
          `<span class="pediterr sub"></span></div></form>` +
          `</div>`
        );
      })
      .join('');
    projViewEl.innerHTML =
      `<div class="projwrap">` +
      `<h2>プロジェクト</h2>` +
      `<div class="sub">読み込むリポジトリを管理します(~/.config/strata/projects.json に保存)。` +
      `「開く」で解析して表示、「編集」で表示名やパスを変更できます。起動時に指定したディレクトリは自動で登録されます</div>` +
      `<div class="paddrow">` +
      `<input id="proj-path" type="text" placeholder="追加するディレクトリのパス(例: ~/work/my-repo)" ` +
      `title="リポジトリのルート(モノレポならモノレポのルート)を指定します">` +
      `<button id="proj-add" title="入力したディレクトリを一覧に追加する">追加</button></div>` +
      `<div id="proj-msg" class="sub"></div>` +
      (missing > 0
        ? `<div class="pprune"><span class="sub">パスが見つからない登録が ${missing} 件あります</span>` +
          `<button id="proj-prune" title="存在しないディレクトリの登録をまとめて削除する">まとめて削除</button></div>`
        : '') +
      (cards || '<div class="sub">登録されたプロジェクトはありません</div>') +
      `<h2 class="csep">複合プロジェクト</h2>` +
      `<div class="sub">複数のリポジトリを束ねて 1 つのワークスペースとして解析します` +
      `(マルチリポ構成のマイクロサービスや、複数案件の横断調査向け。gRPC のサービス間接続もリポジトリを跨いで解決されます)</div>` +
      `<div class="paddrow"><input id="comp-name" type="text" placeholder="複合プロジェクト名(例: 案件A一式)"></div>` +
      `<textarea id="comp-paths" placeholder="リポジトリのパスを 1 行に 1 つ(2 つ以上)
例:
~/work/github.com/org/backend
~/work/github.com/org/frontend"></textarea>` +
      `<div class="paddrow"><button id="comp-add" title="入力した複数リポジトリを 1 つのワークスペースとして束ね、まとめて解析できるようにする">複合プロジェクトを作成</button></div>` +
      `<div id="comp-msg" class="sub"></div>` +
      `</div>`;
  }

  // 編集フォームの保存
  projViewEl.addEventListener('submit', async (ev) => {
    const form = ev.target.closest && ev.target.closest('.pedit');
    if (!form) return;
    ev.preventDefault();
    const err = form.querySelector('.pediterr');
    const nameInput = form.querySelector('input[name="name"]');
    const pathInput = form.querySelector('input[name="newPath"]');
    const payload = { path: form.dataset.editform };
    if (nameInput) payload.name = nameInput.value.trim();
    if (pathInput && !pathInput.disabled) payload.newPath = pathInput.value.trim();
    try {
      const r = await fetch('projects/update', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const j = await r.json();
      if (j.error) {
        if (err) err.textContent = j.error;
        return;
      }
      // 表示中のプロジェクトのパスを変えたら、その新しいパスで開き直す
      if (payload.newPath && PROJ && path0(payload.path) === path0(PROJ) && j.path !== PROJ) {
        location.href = location.pathname + '?p=' + encodeURIComponent(j.path);
        return;
      }
      renderProjects();
    } catch (e) {
      if (err) err.textContent = String(e);
    }
  });
  const path0 = (p) => String(p).replace(/\/+$/, '');

  projViewEl.addEventListener('click', async (ev) => {
    const openEl = ev.target.closest('[data-open]');
    if (openEl) {
      location.href = location.pathname + '?p=' + encodeURIComponent(openEl.dataset.open);
      return;
    }
    const editEl = ev.target.closest('[data-edit]');
    if (editEl) {
      const form = projViewEl.querySelector(`[data-editform="${CSS.escape(editEl.dataset.edit)}"]`);
      if (form) form.classList.toggle('hidden');
      return;
    }
    if (ev.target.closest('[data-editcancel]')) {
      const form = ev.target.closest('.pedit');
      if (form) form.classList.add('hidden');
      return;
    }
    if (ev.target.closest('#proj-prune')) {
      await fetch('projects/prune', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(
        () => {},
      );
      renderProjects();
      return;
    }
    const delEl = ev.target.closest('[data-del]');
    if (delEl) {
      await fetch('projects/delete', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: delEl.dataset.del }),
      }).catch(() => {});
      renderProjects();
      return;
    }
    if (ev.target.closest('#comp-add')) {
      const nameInput = projViewEl.querySelector('#comp-name');
      const pathsInput = projViewEl.querySelector('#comp-paths');
      const name = nameInput && nameInput.value ? nameInput.value.trim() : '';
      const paths = (pathsInput && pathsInput.value ? pathsInput.value : '')
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== '');
      const msg = projViewEl.querySelector('#comp-msg');
      if (name === '' || paths.length < 2) {
        if (msg) msg.textContent = '名前と 2 つ以上のパスを入力してください';
        return;
      }
      try {
        const r = await fetch('projects/composite', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, paths }),
        });
        const j = await r.json();
        if (j.error) {
          if (msg) msg.textContent = j.error;
          return;
        }
        renderProjects();
      } catch (err) {
        if (msg) msg.textContent = String(err);
      }
      return;
    }
    if (ev.target.closest('#proj-add')) {
      const input = projViewEl.querySelector('#proj-path');
      const p = input && input.value ? input.value.trim() : '';
      const msgEl = projViewEl.querySelector('#proj-msg');
      // 空欄のまま黙って return すると「押しても何も起きない」になる
      if (p === '') {
        if (msgEl) msgEl.textContent = '追加したいディレクトリのパスを入力してください(例: ~/work/my-repo)';
        if (input) input.focus();
        return;
      }
      if (msgEl) msgEl.textContent = '';
      try {
        const r = await fetch('projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: p }),
        });
        const j = await r.json();
        if (j.error) {
          const msg = projViewEl.querySelector('#proj-msg');
          if (msg) msg.textContent = j.error;
          return;
        }
        renderProjects();
      } catch (err) {
        const msg = projViewEl.querySelector('#proj-msg');
        if (msg) msg.textContent = String(err);
      }
    }
  });
  projViewEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'proj-path') {
      const btn = projViewEl.querySelector('#proj-add');
      if (btn) btn.click();
    }
  });
  $('#tab-projects').addEventListener('click', () => setTab('projects'));
  $('#wsname').addEventListener('click', () => setTab('projects'));

  // ---------- コミット / PR / diff モーダル(git 連携) ----------
  const gitModalEl = $('#gitmodal');
  async function openCommitModal(sha, rel) {
    const box = $('#gitmodal-box');
    gitModalEl.classList.remove('hidden');
    box.innerHTML = '<div class="sub">コミットを読み込み中…</div>';
    let j;
    try {
      const r = await fetch('commit?sha=' + encodeURIComponent(sha) + '&f=' + encodeURIComponent(rel || '') + projQS('&'));
      j = await r.json();
    } catch (err) {
      box.innerHTML = `<div class="sub">取得に失敗しました: ${esc(String(err))}</div>`;
      return;
    }
    if (j.error) {
      box.innerHTML = `<div class="smhead"><b>コミット ${esc(sha)}</b><button class="close" data-gm-close="1">✕</button></div><div class="sub">${esc(j.error)}</div>`;
      return;
    }
    const date = new Date(j.time * 1000).toLocaleString('ja-JP');
    const prLink =
      j.pr && j.repoUrl
        ? `<a href="${esc(j.repoUrl)}/pull/${j.pr}" target="_blank" rel="noopener" class="gmbtn pr">PR #${j.pr} を開く</a>`
        : '';
    const commitLink = j.repoUrl
      ? `<a href="${esc(j.repoUrl)}/commit/${esc(j.sha)}" target="_blank" rel="noopener" class="gmbtn">GitHub で見る</a>`
      : '';
    const diffHtml = j.patch
      .split('\n')
      .map((l) => {
        let cls = '';
        if (l.startsWith('diff --git') || l.startsWith('commit ')) cls = 'dhead';
        else if (l.startsWith('+++') || l.startsWith('---')) cls = 'dfile';
        else if (l.startsWith('@@')) cls = 'dhunk';
        else if (l.startsWith('+')) cls = 'dadd';
        else if (l.startsWith('-')) cls = 'ddel';
        return `<div class="dl ${cls}">${esc(l) || ' '}</div>`;
      })
      .join('');
    box.innerHTML =
      `<div class="smhead"><b>${esc(j.subject)}</b><button class="close" data-gm-close="1">✕</button></div>` +
      `<div class="gmmeta">${esc(j.sha.slice(0, 10))} ・ ${esc(j.author)} ・ ${esc(date)}` +
      (j.pr && !j.repoUrl ? ` ・ PR #${j.pr}` : '') +
      `<span class="gmlinks">${prLink}${commitLink}</span></div>` +
      `<pre class="gitdiff">${diffHtml}</pre>`;
  }
  gitModalEl.addEventListener('click', (ev) => {
    if (ev.target === gitModalEl || ev.target.closest('[data-gm-close]')) {
      gitModalEl.classList.add('hidden');
    }
  });

  // ---------- スタックトレース解析 ----------
  const stackModalEl = $('#stackmodal');
  // 既知ファイル(ws 相対パス)の索引: スタックトレースの絶対パスをサフィックス一致で解決する
  const knownFiles = [];
  {
    const seen = new Set();
    for (const n of model.nodes) {
      const f = n.kind === 'file' || n.kind === 'proto' ? n.id : n.meta && n.meta.file;
      if (f && !seen.has(f)) {
        seen.add(f);
        knownFiles.push(f);
      }
    }
  }
  function resolveKnownFile(p) {
    const clean = p.replace(/^\.\//, '');
    if (knownFiles.includes(clean)) return clean;
    let best = null;
    for (const f of knownFiles) {
      if (clean.endsWith('/' + f) || f.endsWith('/' + clean)) {
        if (best === null || f.length > best.length) best = f;
      }
    }
    if (best) return best;
    // 末尾のパス要素だけでも一致を探す(basename 一致は一意な場合のみ)
    const base = clean.slice(clean.lastIndexOf('/') + 1);
    const hits = knownFiles.filter((f) => f.endsWith('/' + base) || f === base);
    return hits.length === 1 ? hits[0] : null;
  }
  function parseStackTrace(text) {
    const frames = [];
    const seen = new Set();
    for (const raw of text.split('\n')) {
      const line = raw.trim();
      if (line === '') continue;
      // 1) ファイル:行(Go の 2 行目形式・Elixir・一般形式)
      const fm = line.match(/([^\s:()"']+\.(?:go|ts|tsx|js|jsx|mjs|cjs|ex|exs|proto)):(\d+)/);
      if (fm) {
        const rel = resolveKnownFile(fm[1]);
        if (rel) {
          const key = rel + ':' + fm[2];
          if (!seen.has(key)) {
            seen.add(key);
            frames.push({ file: rel, line: Number(fm[2]), label: rel.slice(rel.lastIndexOf('/') + 1), kind: 'file' });
          }
          continue;
        }
      }
      // 2) 関数名(行内の最後の `Name(` を関数索引と突き合わせ)
      const calls = [...line.matchAll(/([A-Za-z_]\w*)\s*\(/g)];
      if (calls.length > 0) {
        const name = calls[calls.length - 1][1];
        const defs = funcDefIndex.get(name);
        if (defs && defs.length > 0) {
          const key = defs[0].file + ':' + defs[0].line;
          if (!seen.has(key)) {
            seen.add(key);
            frames.push({ file: defs[0].file, line: defs[0].line, label: name, kind: 'func' });
          }
        }
      }
    }
    return frames;
  }
  function renderStackResults(frames, totalLines) {
    const items = frames
      .map(
        (f, i) =>
          `<div class="sframe" data-sfile="${esc(f.file)}" data-sline="${f.line}">` +
          `<span class="fno">${i + 1}</span>` +
          `<span class="ic ${f.kind === 'func' ? 'func' : ''}">${f.kind === 'func' ? 'ƒ' : '·'}</span>` +
          `<span class="lb">${esc(f.label)}</span>` +
          `<span class="floc">${esc(f.file)}:${f.line}</span></div>`,
      )
      .join('');
    $('#stack-results').innerHTML =
      items || '<div class="sub">このワークスペースのコードに一致するフレームが見つかりませんでした</div>';
    $('#stack-note').textContent = frames.length > 0 ? `${frames.length} フレームを解決(クリックでコードを開く)` : '';
    void totalLines;
  }
  $('#btn-stack').addEventListener('click', () => {
    stackModalEl.classList.remove('hidden');
  });
  stackModalEl.addEventListener('click', (ev) => {
    if (ev.target === stackModalEl || ev.target.closest('#stack-close')) {
      stackModalEl.classList.add('hidden');
      return;
    }
    if (ev.target.closest('#stack-parse')) {
      const text = ($('#stack-input') && $('#stack-input').value) || '';
      renderStackResults(parseStackTrace(text), text.split('\n').length);
      return;
    }
    const frame = ev.target.closest('[data-sfile]');
    if (frame) {
      stackModalEl.classList.add('hidden');
      setTab('api');
      openSourceFile(frame.dataset.sfile, Number(frame.dataset.sline));
    }
  });

  // ---------- 操作 ----------
  // 構造ビューのナビゲーション履歴(フォーカス + スクロール位置)。
  // ジャンプ(依存一覧・経路・循環などのクリック)から ← で元の場所に戻れる
  const nav = { back: [], fwd: [] };
  function navSnapshot() {
    return {
      tab: state.tab === 'diagram' ? 'diagram' : 'structure',
      focus: state.focus,
      scroll: mainEl.scrollTop || 0,
    };
  }
  function updateNavButtons() {
    const b = $('#btn-back');
    const f = $('#btn-fwd');
    if (b) b.disabled = nav.back.length === 0;
    if (f) f.disabled = nav.fwd.length === 0;
  }
  function navGo(dir) {
    const src = dir === 'back' ? nav.back : nav.fwd;
    const dst = dir === 'back' ? nav.fwd : nav.back;
    const h = src.pop();
    if (!h) return;
    dst.push(navSnapshot());
    state.focus = h.focus;
    if (h.focus !== null && state.sideMode !== 'cycles') state.sideMode = 'info';
    if (h.tab === 'diagram') {
      if (state.tab !== 'diagram') setTab('diagram');
      else renderDiagram();
      if (h.focus !== null) {
        sideEl.classList.remove('hidden');
        renderSide();
      } else {
        sideEl.classList.add('hidden');
      }
    } else {
      if (state.tab !== 'structure') setTab('structure');
      else render();
      if (h.focus !== null && rowIndex.get(h.focus) === undefined) scrollToRow(h.focus);
      else mainEl.scrollTop = h.scroll;
    }
    updateNavButtons();
  }
  $('#btn-back').addEventListener('click', () => navGo('back'));
  $('#btn-fwd').addEventListener('click', () => navGo('fwd'));

  function setFocus(id) {
    if (id !== state.focus) {
      nav.back.push(navSnapshot());
      if (nav.back.length > 100) nav.back.shift();
      nav.fwd.length = 0;
      updateNavButtons();
    }
    state.focus = id;
    // 図ビュー内では図と詳細パネルを更新する(構造ビューへは飛ばない)
    if (state.tab === 'diagram') {
      if (id !== null) state.sideMode = 'info';
      renderDiagram();
      if (id !== null) {
        sideEl.classList.remove('hidden');
        renderSide();
      } else {
        sideEl.classList.add('hidden');
      }
      return;
    }
    if (id && state.sideMode !== 'cycles') state.sideMode = 'info';
    if (!id) {
      state.traceDir = null;
      if (state.sideMode === 'info') state.sideMode = null;
    }
    render();
    syncHash();
  }
  function scrollToRow(id) {
    const i = rowIndex.get(id);
    if (i === undefined) {
      // 祖先を展開して再試行
      for (const a of chain(id).slice(0, -1)) if (hasKids(a)) state.expanded.add(a);
      render();
    }
    const el = treeEl.querySelector(`.row[data-id="${CSS.escape(id)}"]`);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // 行ホバー: その行に接続する依存線をハイライトし、他を減光(線の追跡用)。
  // 出る線(この行 → 依存先)は緑、入る線(依存元 → この行)は青で向きを示す。
  // 直前の対象要素だけをクリア → 新しい対象だけ設定するので、全 path/circle 走査を避ける。
  function applyRowHover(id) {
    if (id === hoverState.lastId) return; // 同一行の連続ホバーはスキップ
    for (const el of hoverState.lastEls) el.classList.remove('hl-hover', 'hl-out', 'hl-in');
    hoverState.lastEls = [];
    const hits = id !== null ? hoverIndex.get(id) : null;
    if (!hits || hits.length === 0) {
      arcsEl.classList.remove('rowhover');
      hoverState.lastId = id;
      return;
    }
    const outSet = new Set(); // out と in の両方に出る要素は out を優先
    for (const { el, dir } of hits) if (dir === 'out') outSet.add(el);
    for (const { el, dir } of hits) {
      el.classList.add('hl-hover');
      if (dir === 'out') el.classList.add('hl-out');
      else if (!outSet.has(el)) el.classList.add('hl-in');
      hoverState.lastEls.push(el);
    }
    arcsEl.classList.add('rowhover');
    hoverState.lastId = id;
  }
  treeEl.addEventListener('mouseover', (ev) => {
    const rowEl = ev.target.closest('.row');
    if (rowEl) applyRowHover(rowEl.dataset.id);
  });
  treeEl.addEventListener('mouseleave', () => applyRowHover(null));

  treeEl.addEventListener('click', (ev) => {
    const rowEl = ev.target.closest('.row');
    if (!rowEl) return;
    const id = rowEl.dataset.id;
    if (ev.target.dataset && ev.target.dataset.hide !== undefined) {
      state.structHidden.add(id);
      persistHidden();
      if (state.focus === id) state.focus = null;
      render();
      return;
    }
    if (ev.target.dataset && ev.target.dataset.bm !== undefined) {
      toggleBookmark(id);
      return;
    }
    if (ev.target.dataset.tw !== undefined && hasKids(id)) {
      if (state.expanded.has(id)) state.expanded.delete(id);
      else state.expanded.add(id);
      render();
      return;
    }
    setFocus(state.focus === id ? null : id);
  });
  treeEl.addEventListener('dblclick', (ev) => {
    const rowEl = ev.target.closest('.row');
    if (!rowEl) return;
    const id = rowEl.dataset.id;
    if (!hasKids(id)) return;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    render();
  });
  sideEl.addEventListener('click', (ev) => {
    const apiPick = ev.target.closest('[data-dgapi]');
    if (apiPick) {
      ev.stopPropagation();
      const id = apiPick.dataset.dgapi;
      state.dgApi = state.dgApi === id ? null : id; // 同じものを押したら解除
      renderDiagram();
      renderSide();
      return;
    }
    const bmRemove = ev.target.closest('[data-bm-remove]');
    if (bmRemove) {
      ev.stopPropagation();
      state.bookmarks.delete(bmRemove.dataset.bmRemove);
      persistBookmarks();
      render();
      return;
    }
    const srcChip = ev.target.closest('[data-srcfile]');
    if (srcChip) {
      setTab('api');
      openSourceFile(srcChip.dataset.srcfile, srcChip.dataset.srcline ? Number(srcChip.dataset.srcline) : null);
      return;
    }
    if (ev.target.closest('#path-clear')) {
      state.pathTarget = null;
      state.pathQuery = '';
      renderSide();
      return;
    }
    const cand = ev.target.closest('[data-path-target]');
    if (cand) {
      state.pathTarget = cand.dataset.pathTarget;
      renderSide();
      return;
    }
    const item = ev.target.closest('[data-id]');
    if (!item) return;
    const id = item.dataset.id;
    setFocus(id);
    if (state.tab !== 'diagram') scrollToRow(id);
  });
  sideEl.addEventListener('input', (ev) => {
    if (ev.target && ev.target.id === 'path-q') state.pathQuery = ev.target.value;
  });
  sideEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && ev.target && ev.target.id === 'path-q') {
      state.pathTarget = null;
      renderSide();
      const input = sideEl.querySelector('#path-q');
      if (input && input.focus) input.focus();
    }
  });
  // ---------- キーボードショートカット ----------
  // 構造タブのツリーをマウスなしで辿れるようにする。入力欄にフォーカスがある間は
  // 既定動作を尊重する(Escape だけは欄からフォーカスを外す)。
  const inTextField = (t) =>
    t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);

  // `?` で開くショートカット一覧オーバーレイ(必要時に生成)
  let helpEl = null;
  // macOS では Option / Command 記号で書く(このツールの主な配布先が macOS のため)。
  // DOM スタブのテスト環境では navigator が無いので false 扱いにする。
  const IS_MAC =
    typeof navigator !== 'undefined' &&
    // userAgentData.platform は "macOS"(小文字 m)を返すため大文字小文字を無視して判定する
    /mac|iphone|ipad/i.test(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
  const HELP_ROWS = [
    ['↑ / ↓', '行を上下に移動'],
    ['→ / ←', '展開 / 折りたたみ(葉なら親子を移動)'],
    ['Enter', '折りたたみを開閉'],
    ['/', '検索欄へフォーカス'],
    ['b', 'フォーカス行をブックマーク'],
    ['Esc', 'モーダル / プレビュー / 選択を閉じる'],
    [IS_MAC ? '⌥ + ← / →' : 'Alt + ← / →', '戻る / 進む(フォーカス履歴)'],
    ['?', 'このヘルプを開閉'],
    ['再解析ボタン', 'コードを解析し直して表示を更新(表示位置は保持)'],
    ['クリック', 'フォーカス(依存線を強調)'],
    ['ホバー', 'その行の依存線だけ強調'],
    [IS_MAC ? '⌘ + クリック' : 'Ctrl + クリック', 'ソース上で定義へジャンプ'],
  ];
  {
    const hb = $('#btn-help');
    if (hb && hb.addEventListener) hb.addEventListener('click', () => toggleHelp());
  }

  /* ---------- 再解析(リロード) ----------
     /model.json はリクエストのたびにスキャンし直すため、読み込み直せば最新になる。
     フォーカス・検索・並び・タブは URL ハッシュに入っているので、リロードしても位置は戻る。 */
  {
    const rb = $('#btn-reload');
    if (rb && rb.addEventListener) {
      rb.addEventListener('click', () => {
        if (rb.classList) rb.classList.add('busy');
        rb.title = '再解析中…';
        // ハッシュ(表示位置)を確定させてから読み直す
        try {
          if (typeof syncHash === 'function') syncHash();
        } catch {
          // ハッシュ同期に失敗してもリロードは行う
        }
        if (typeof location !== 'undefined' && typeof location.reload === 'function') location.reload();
      });
    }
  }

  /* ---------- テーマ切替(自動 → ライト → ダーク) ----------
     既定は「自動」= OS 設定に追従(CSS の prefers-color-scheme)。
     手動で選んだ場合だけ <html data-theme="light|dark"> を立て、localStorage に保存する */
  const THEME_KEY = 'strata.theme';
  const THEME_ORDER = ['auto', 'light', 'dark'];
  // 記号・絵文字はフォントによって大きさと基線がばらつくので SVG で描く
  const svgIcon = (paths) =>
    `<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" ` +
    `stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const THEME_UI = {
    auto: {
      // 半月(左半分を塗る)= OS 設定に追従
      icon: svgIcon('<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 0 0 16z" fill="currentColor" stroke="none"/>'),
      label: 'テーマ: 自動(OS 設定に追従)。クリックでライトへ',
    },
    light: {
      icon: svgIcon('<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
      label: 'テーマ: ライト。クリックでダークへ',
    },
    dark: {
      icon: svgIcon('<path d="M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5z"/>'),
      label: 'テーマ: ダーク。クリックで自動へ',
    },
  };
  function applyTheme(mode) {
    const root = typeof document !== 'undefined' && document.documentElement;
    if (root && root.setAttribute) {
      if (mode === 'auto') {
        if (root.removeAttribute) root.removeAttribute('data-theme');
      } else {
        root.setAttribute('data-theme', mode);
      }
    }
    const btn = $('#btn-theme');
    if (btn) {
      const ui = THEME_UI[mode] || THEME_UI.auto;
      btn.innerHTML = ui.icon;
      btn.title = ui.label;
      if (btn.setAttribute) btn.setAttribute('aria-label', ui.label);
    }
  }
  {
    let mode = 'auto';
    if (typeof localStorage !== 'undefined') {
      const saved = localStorage.getItem(THEME_KEY);
      if (THEME_ORDER.includes(saved)) mode = saved;
    }
    applyTheme(mode);
    const tb = $('#btn-theme');
    if (tb && tb.addEventListener) {
      tb.addEventListener('click', () => {
        mode = THEME_ORDER[(THEME_ORDER.indexOf(mode) + 1) % THEME_ORDER.length];
        if (typeof localStorage !== 'undefined') localStorage.setItem(THEME_KEY, mode);
        applyTheme(mode);
        // SVG(依存線・アーキ図)の色は CSS 変数参照なので再描画は不要
      });
    }
  }
  function toggleHelp() {
    if (!helpEl) {
      helpEl = document.createElement('div');
      helpEl.id = 'helpmodal';
      helpEl.className = 'hidden';
      helpEl.innerHTML =
        '<div class="helpbox"><div class="helphead"><b>キーボード / 操作ショートカット</b>' +
        '<button class="close" data-help-close aria-label="閉じる">✕</button></div><table class="helptbl">' +
        HELP_ROWS.map((r) => `<tr><td class="k">${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('') +
        '</table>' +
        // 詳しい使い方は説明書(ドキュメントサイト)へ誘導する
        '<div class="helpfoot">📖 詳しい使い方・設定・設計の意図は ' +
        '<a href="https://makoto-developer.github.io/strata/" target="_blank" rel="noopener">説明書(ドキュメントサイト)</a>' +
        ' にまとまっています</div>' +
        '</div>';
      helpEl.addEventListener('click', (ev) => {
        if (ev.target === helpEl || ev.target.closest('[data-help-close]')) helpEl.classList.add('hidden');
      });
      document.body.appendChild(helpEl);
    }
    helpEl.classList.toggle('hidden');
  }
  const focusedRowIndex = () =>
    state.focus != null && rowIndex.has(state.focus) ? rowIndex.get(state.focus) : -1;
  function moveFocusByRow(delta) {
    if (rows.length === 0) return;
    let i = focusedRowIndex();
    if (i === -1) i = delta > 0 ? -1 : rows.length;
    const ni = Math.max(0, Math.min(rows.length - 1, i + delta));
    const id = rows[ni].id;
    setFocus(id);
    scrollToRow(id);
  }
  function expandOrDescend() {
    const id = state.focus;
    if (id == null) return moveFocusByRow(1);
    if (hasKids(id) && !state.expanded.has(id)) {
      state.expanded.add(id);
      render();
      scrollToRow(id);
    } else {
      moveFocusByRow(1); // 既に展開/葉なら次の行(=最初の子)へ
    }
  }
  function collapseOrAscend() {
    const id = state.focus;
    if (id == null) return moveFocusByRow(-1);
    if (hasKids(id) && state.expanded.has(id)) {
      state.expanded.delete(id);
      render();
      scrollToRow(id);
    } else {
      const anc = chain(id); // [root..id]
      const parent = anc.length >= 2 ? anc[anc.length - 2] : null;
      if (parent) {
        setFocus(parent);
        scrollToRow(parent);
      }
    }
  }
  function toggleExpandFocused() {
    const id = state.focus;
    if (id == null || !hasKids(id)) return;
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    render();
    scrollToRow(id);
  }

  document.addEventListener('keydown', (ev) => {
    if (ev.altKey && ev.key === 'ArrowLeft') {
      navGo('back');
      return;
    }
    if (ev.altKey && ev.key === 'ArrowRight') {
      navGo('fwd');
      return;
    }
    if (ev.key === 'Escape') {
      // 上に重なっているものから順に閉じる
      if (helpEl && !helpEl.classList.contains('hidden')) return helpEl.classList.add('hidden');
      if (inTextField(ev.target) && ev.target.blur) {
        ev.target.blur();
        return;
      }
      if (!gitModalEl.classList.contains('hidden')) return gitModalEl.classList.add('hidden');
      if (!stackModalEl.classList.contains('hidden')) return stackModalEl.classList.add('hidden');
      hideDefPeek();
      if (state.tab === 'api' && !apiSrcEl.classList.contains('hidden')) {
        apiSrcEl.classList.add('hidden');
        return;
      }
      setFocus(null);
      return;
    }
    if (inTextField(ev.target)) return; // 入力中はショートカットを横取りしない
    // `?` でキーボードショートカットのヘルプを開閉
    if (ev.key === '?') {
      ev.preventDefault();
      toggleHelp();
      return;
    }
    // `/` で検索欄へ
    if (ev.key === '/') {
      const s = $('#search');
      if (s) {
        ev.preventDefault();
        s.focus();
        s.select && s.select();
      }
      return;
    }
    // 構造タブのツリーナビゲーション
    if (state.tab !== 'structure') return;
    if (ev.key === 'b' && state.focus) {
      ev.preventDefault();
      toggleBookmark(state.focus);
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveFocusByRow(1);
    } else if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveFocusByRow(-1);
    } else if (ev.key === 'ArrowRight') {
      ev.preventDefault();
      expandOrDescend();
    } else if (ev.key === 'ArrowLeft') {
      ev.preventDefault();
      collapseOrAscend();
    } else if (ev.key === 'Enter') {
      ev.preventDefault();
      toggleExpandFocused();
    }
  });

  $('#btn-overview').addEventListener('click', () => {
    expandToDepth(0);
    state.traceDir = null;
    render();
  });
  $('#btn-modules').addEventListener('click', () => {
    expandToDepth(1);
    state.traceDir = null;
    render();
  });
  $('#btn-expand').addEventListener('click', () => {
    for (const n of model.nodes) if (hasKids(n.id)) state.expanded.add(n.id);
    render();
  });
  $('#btn-collapse').addEventListener('click', () => {
    state.expanded = new Set();
    state.traceDir = null;
    render();
  });
  $('#sort').addEventListener('change', (ev) => {
    state.sort = ev.target.value;
    render();
    syncHash();
  });
  // 構造ビュー: サービス絞り込み(検索つきコンボ)と線種フィルタ
  {
    const wrap = $('#struct-svc-wrap');
    const roots = (childrenOf.get('') || []).slice().sort((a, b) => {
      const la = byId.get(a) ? byId.get(a).label : a;
      const lb = byId.get(b) ? byId.get(b).label : b;
      return la.localeCompare(lb);
    });
    const labelOf = (id) => (byId.get(id) ? byId.get(id).label : id);
    const options = [
      { value: '', label: `全サービス (${roots.length})` },
      ...roots.map((id) => ({ value: id, label: labelOf(id) })),
    ];
    const renderStructCombo = () => {
      wrap.innerHTML = comboMarkup(
        'struct',
        state.structSvc === '' ? '' : labelOf(state.structSvc),
        `全サービス (${roots.length})`,
        options,
      );
    };
    bindCombos(wrap, (key, value) => {
      let v = value;
      if (v !== '' && !byId.has(v)) {
        // Enter で生テキストが来た場合はラベル一致で解決する
        const hit = roots.find((id) => labelOf(id).toLowerCase() === v.toLowerCase());
        if (!hit) return;
        v = hit;
      }
      state.structSvc = v;
      if (v !== '' && hasKids(v)) state.expanded.add(v);
      renderStructCombo();
      render();
    });
    renderStructCombo();
  }
  $('#struct-kinds').addEventListener('click', (ev) => {
    const chip = ev.target.closest('[data-skind]');
    if (!chip) return;
    const k = chip.dataset.skind;
    if (state.structKinds.has(k)) state.structKinds.delete(k);
    else state.structKinds.add(k);
    chip.classList.toggle('on', state.structKinds.has(k));
    render();
  });
  $('#violations').addEventListener('click', () => {
    state.violationsOnly = !state.violationsOnly;
    const btn = $('#violations');
    if (btn.classList) btn.classList.toggle('on', state.violationsOnly);
    if (btn.setAttribute) btn.setAttribute('aria-pressed', String(state.violationsOnly));
    render();
  });
  // 検索フィルタチップ(テストを除外 / 種別)
  function refreshSearchFilterChips() {
    const el = $('#searchfilters');
    if (!el || !el.querySelectorAll) return;
    for (const chip of el.querySelectorAll('[data-sf]')) {
      const key = chip.dataset.sf;
      const on = key === 'notest' ? state.searchExcludeTests : state.searchKinds.has(key);
      chip.classList.toggle('on', on);
    }
  }
  $('#searchfilters').addEventListener('click', (ev) => {
    const chip = ev.target.closest && ev.target.closest('[data-sf]');
    if (!chip) return;
    const key = chip.dataset.sf;
    if (key === 'notest') {
      state.searchExcludeTests = !state.searchExcludeTests;
    } else {
      if (state.searchKinds.has(key)) state.searchKinds.delete(key);
      else state.searchKinds.add(key);
    }
    persistSearchFilters();
    refreshSearchFilterChips();
    render();
  });
  refreshSearchFilterChips();

  let searchTimer = null;
  $('#search').addEventListener('input', (ev) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = ev.target.value.trim();
      if (state.tab === 'api') {
        renderApiList();
        return;
      }
      if (state.q) {
        const q = state.q.toLowerCase();
        for (const n of model.nodes) {
          if (state.searchExcludeTests && isTestNode(n)) continue;
          if (!searchKindOk(n)) continue;
          if (n.label.toLowerCase().includes(q) || n.id.toLowerCase().includes(q)) {
            for (const a of chain(n.id).slice(0, -1)) if (hasKids(a)) state.expanded.add(a);
          }
        }
      }
      render();
      syncHash();
    }, 200);
  });
  void mainEl;

  render();
  applyHash();

  /* ---------- ホバーのツールチップ(操作の説明) ----------
     ブラウザ標準の title ツールチップは表示まで 1 秒以上かかり、見た目もテーマに合わない。
     hover した要素の title(または SVG の <title> 子要素)を拾って自前のチップを出す。
     title は data-tip へ退避し、標準ツールチップとの二重表示を防ぐ。 */
  const TIP_DELAY = 240;
  const tip = { el: null, target: null, timer: null };

  function tipTextOf(el) {
    if (!el || !el.getAttribute) return '';
    const own = el.getAttribute('data-tip') || el.getAttribute('title');
    if (own) return own;
    // 依存線・アーキ図の辺は SVG の <title> 子要素で説明を持つ
    if (el.tagName && el.querySelector) {
      const child = el.querySelector('title');
      if (child && child.parentNode === el && child.textContent) return child.textContent;
    }
    return '';
  }

  function tipTargetOf(node) {
    let cur = node;
    for (let depth = 0; cur && depth < 5; depth++) {
      if (tipTextOf(cur)) return cur;
      cur = cur.parentElement || cur.parentNode;
    }
    return null;
  }

  function hideTip() {
    if (tip.timer) clearTimeout(tip.timer);
    tip.timer = null;
    tip.target = null;
    if (tip.el && tip.el.classList) tip.el.classList.remove('on');
  }

  function placeTip(target) {
    if (!tip.el || !target.getBoundingClientRect) return;
    const r = target.getBoundingClientRect();
    const t = tip.el.getBoundingClientRect();
    const vw = window.innerWidth || 1280;
    const vh = window.innerHeight || 800;
    let left = r.left;
    let top = r.bottom + 7;
    if (top + t.height > vh - 8) top = Math.max(8, r.top - t.height - 7); // 下が狭ければ上へ
    if (left + t.width > vw - 8) left = Math.max(8, vw - t.width - 8);
    tip.el.style.left = Math.round(left) + 'px';
    tip.el.style.top = Math.round(top) + 'px';
  }

  function showTip(target) {
    const text = tipTextOf(target);
    if (!text) return;
    // 標準ツールチップを止め、以後は data-tip から読む(動的に title を書き換える箇所も拾える)
    if (target.getAttribute && target.getAttribute('title') && target.removeAttribute) {
      target.setAttribute('data-tip', text);
      target.removeAttribute('title');
    }
    if (!tip.el) {
      if (typeof document.createElement !== 'function') return;
      tip.el = document.createElement('div');
      tip.el.id = 'tip';
      tip.el.setAttribute('role', 'tooltip');
      document.body.appendChild(tip.el);
    }
    tip.el.textContent = text;
    tip.el.classList.add('on');
    placeTip(target);
  }

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('mouseover', (ev) => {
      const target = tipTargetOf(ev.target);
      if (!target || target === tip.target) return;
      hideTip();
      tip.target = target;
      tip.timer = setTimeout(() => showTip(target), TIP_DELAY);
    });
    document.addEventListener('mouseout', (ev) => {
      if (!tip.target) return;
      const to = ev.relatedTarget;
      if (to && tip.target.contains && tip.target.contains(to)) return; // 子要素への移動は維持
      hideTip();
    });
    // 押した / 動かした / 画面が変わったら消す(操作の邪魔をしない)
    document.addEventListener('mousedown', hideTip);
    document.addEventListener('wheel', hideTip, { passive: true });
    document.addEventListener('scroll', hideTip, true);
    if (typeof window.addEventListener === 'function') window.addEventListener('blur', hideTip);
  }

  // watch モード: サーバの SSE を購読し、ファイル変更で自動リロード(serve --watch 時のみ発火)
  if (!IS_STATIC && typeof EventSource !== 'undefined') {
    try {
      const es = new EventSource('events' + projQS('?'));
      es.addEventListener('reload', () => location.reload());
    } catch {
      // EventSource 不可でも通常動作に影響なし
    }
  }
})();
