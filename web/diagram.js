// 図タブ(アーキテクチャ図)。app.js から切り出したビュー。
//
// app.js は 1 ファイル 4,700 行で、100 の関数が同じスコープの可変状態を共有していた。
// view 単位に切って、依存を ctx として明示的に受け取る形にする。
// 図タブから選んだのは、実ブラウザ監査(scripts/audit-viewer.mjs)の検査が最も厚く、
// 切り出しの正しさを機械的に確かめられるため。
//
// ブラウザにもエクスポート HTML にも同じ 1 本の JS を配るので(src/export.ts の
// bundleViewerJs)、import/export はビルド時に落ちる。ここでは読みやすさのために書く。

/**
 * 図タブを初期化し、外から呼ぶ入口を返す。
 * ctx は app.js が持つ共有物(モデル・索引・状態・他ビューの再描画)。
 */
export function initDiagram(ctx) {
  const {
    byId, chain, childrenOf, diagramViewEl, esc, model,
    persistHidden, render, renderSide, rpcCallers, rpcImpls,
    setFocus, state, subtreeLoc, tarjan,
  } = ctx;

  function computeServiceGraph() {
    const implTopOf = (rpcId) => {
      const impls = rpcImpls.get(rpcId);
      // 実装は複数ありうる。1 つだけ採ると、選ばれなかったサービスへの線が消える
      return impls && impls.size > 0 ? [...new Set([...impls].map((i) => chain(i)[0]))] : [];
    };
    const targetTops = (toId) => {
      const node = byId.get(toId);
      if (node && node.kind === 'rpc') {
        const t = implTopOf(toId);
        if (t.length > 0) return t;
      } else if (node && node.kind === 'proto') {
        const all = new Set();
        for (const kid of childrenOf.get(toId) || []) for (const t of implTopOf(kid)) all.add(t);
        if (all.size > 0) return [...all];
      }
      return [chain(toId)[0]];
    };
    const tops = (childrenOf.get('') || []).filter((id) => !state.structHidden.has(id));
    const topSet = new Set(tops);
    const edgeMap = new Map();
    for (const e of model.edges) {
      if (e.kind === 'impl') continue;
      const a = chain(e.from)[0];
      // 実装が複数あるときは全部へ線を引く(どれが動くかは実行時に決まる)
      for (const b of targetTops(e.to)) {
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
        // 実装が複数あるなら、その全部が「この API を公開している」
        const owners = impls && impls.size > 0 ? new Set([...impls].map((i) => chain(i)[0])) : new Set([chain(n.id)[0]]);
        for (const owner of owners) rpcCount.set(owner, (rpcCount.get(owner) || 0) + 1);
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
  return { renderDiagram };
}
