// 間接層(生成クライアント・多段中継)の解析を、企業システムでよくある構成パターンで検証する。
// 実行: npm test
//
// 各パターンは完全に架空のもの。実在する組織の構成・命名は持ち込まない。
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.ts';
import { parseGraph } from '../src/model.ts';
import { findTopicRefs } from '../src/analyzers/messaging.ts';

const fail = (msg) => { console.error('✖ ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('✓ ' + msg);

const patternsDir = fileURLToPath(new URL('./fixtures/patterns', import.meta.url));
const demoDir = fileURLToPath(new URL('../examples/indirection-demo', import.meta.url));

const rpcEdges = (model) => model.edges.filter((e) => e.kind === 'rpc');
const hasRpc = (model, from, to) => rpcEdges(model).some((e) => e.from === from && e.to.endsWith(to));
const unresolvedOf = (model, detail) => (model.unresolved ?? []).filter((u) => u.detail === detail);

/** fixture を一時ディレクトリへ複製し、strata.config.json を書き換えてから解析する。 */
function scanWith(dir, mutate) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-pattern-'));
  fs.cpSync(dir, tmp, { recursive: true });
  const configFile = path.join(tmp, 'strata.config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  mutate(config);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  try {
    return scan(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** fixture を一時ディレクトリへ複製し、strata.config.json から指定キー(a.b 形式)を外して解析する。 */
function scanWithout(dir, key) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-pattern-'));
  fs.cpSync(dir, tmp, { recursive: true });
  const configFile = path.join(tmp, 'strata.config.json');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  const parts = key.split('.');
  let target = config;
  for (const part of parts.slice(0, -1)) target = target?.[part] ?? {};
  delete target[parts[parts.length - 1]];
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
  try {
    return scan(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// --- パターン A: proto と実装が同居する素朴な構成(既存挙動の回帰) ---
{
  const model = scan(path.join(patternsDir, 'direct-monorepo'));
  const impl = model.edges.filter((e) => e.kind === 'impl');
  if (impl.length === 1 && impl[0].to.endsWith('#server.Reserve')) ok('直結: proto 同居の実装が impl で繋がる');
  else fail('直結: impl エッジが期待どおりでない');
  if ((model.unresolved ?? []).length === 0) ok('直結: 未解決を出さない(設定なしで従来どおり)');
  else fail('直結: 設定なしなのに未解決が出ている');
}

// --- パターン B: 生成クライアントを vendor に取り込み、パスが proto と全く無関係 ---
{
  const dir = path.join(patternsDir, 'vendored-client');
  const model = scan(dir);
  if (hasRpc(model, 'app', 'CatalogService.GetItem')) ok('vendor 取り込み: パスが無関係でも呼び出しが繋がる');
  else fail('vendor 取り込み: 呼び出しが繋がらない');

  const artifact = model.nodes.find((n) => n.kind === 'artifact');
  if (artifact && artifact.id.includes('catalogclient')) ok('vendor 取り込み: 生成物を署名で同定する');
  else fail('vendor 取り込み: 生成物ノードがない');

  if (model.edges.some((e) => e.kind === 'generates' && e.to === artifact?.id))
    ok('vendor 取り込み: proto → 生成物の generates エッジ');
  else fail('vendor 取り込み: generates エッジがない');

  const viaEdge = rpcEdges(model).find((e) => e.from === 'app');
  if (viaEdge?.via?.length === 1 && viaEdge.via[0] === artifact?.id)
    ok('vendor 取り込み: 経由した生成物を via に残す');
  else fail('vendor 取り込み: via が期待どおりでない');

  // opt-in の確認: indirection を外すと繋がらず、未解決も出ない(従来どおりの挙動に戻る)
  const off = scanWithout(dir, 'indirection');
  if (!hasRpc(off, 'app', 'CatalogService.GetItem') && (off.unresolved ?? []).length === 0)
    ok('vendor 取り込み: indirection を外すと接続も未解決も出ない(opt-in)');
  else fail('vendor 取り込み: opt-in が効いていない');
}

// --- パターン B2: proto も生成クライアントも別リポジトリ。実装側と呼び出し側が別リポジトリに分かれる ---
{
  const dir = path.join(patternsDir, 'generated-server');
  const model = scan(dir);

  // 実装側は「解決済みの proto」を import しないので、間接層側で繋ぎ直す必要がある
  if (model.edges.some((e) => e.kind === 'impl' && e.to === 'svc-a/src#FooServer.GetFoo'))
    ok('生成クライアント: サーバ実装が impl で繋がる');
  else fail('生成クライアント: サーバ実装が繋がらない(呼び出しの矢印が共有 proto に溜まる)');

  if (hasRpc(model, 'svc-b', 'FooService.GetFoo')) ok('生成クライアント: 呼び出し側が繋がる');
  else fail('生成クライアント: 呼び出し側が繋がらない');

  // 生成物ノードは置き場所の下に入れる(トップレベルに置くとパッケージ数だけ図の箱が増える)
  const artifact = model.nodes.find((n) => n.kind === 'artifact');
  if (artifact?.parent === 'client-lib/foo') ok('生成クライアント: 生成物が置き場所の下に入る');
  else fail('生成クライアント: 生成物がトップレベルに出ている');

  // 入れ子モジュールはリポジトリ名でまとまり、名前は go.mod の module から取る
  const svcA = model.nodes.find((n) => n.id === 'svc-a/src');
  if (svcA?.parent === 'svc-a' && svcA.label === 'svc-a')
    ok('生成クライアント: 入れ子モジュールがリポジトリ名の下に入り、go.mod の名前を使う');
  else fail('生成クライアント: 入れ子モジュールの親か名前が期待どおりでない');

  // 1 つの型が複数 service を実装する(Unimplemented... の埋め込みが複数)
  if (model.edges.some((e) => e.kind === 'impl' && e.to === 'svc-a/src#FooServer.Ping'))
    ok('生成クライアント: 型に埋め込まれた 2 つ目の service も繋ぐ');
  else fail('生成クライアント: 2 つ目の埋め込みを取りこぼしている');

  // 同じ contract の実装が複数あっても、先に繋がった 1 件で打ち切らない
  const getFoo = model.edges.filter((e) => e.kind === 'impl' && e.from.endsWith('FooService.GetFoo'));
  if (getFoo.length === 2 && getFoo.some((e) => e.to === 'svc-c#AltFooServer.GetFoo'))
    ok('生成クライアント: 同じ RPC の実装が複数あっても全部繋ぐ');
  else fail('生成クライアント: 2 つ目の実装が繋がっていない');

  const off = scanWithout(dir, 'indirection');
  if (!off.edges.some((e) => e.kind === 'impl') && !hasRpc(off, 'svc-b', 'FooService.GetFoo'))
    ok('生成クライアント: indirection を外すと実装も呼び出しも繋がらない(opt-in)');
  else fail('生成クライアント: opt-in が効いていない');

  // exclude のグロブは生成物の走査にも効く(走査系ごとに実装が分かれていると漏れる)
  const excluded = scanWith(dir, (config) => {
    config.exclude = ['**/client-lib/**'];
  });
  if (!excluded.nodes.some((n) => n.kind === 'artifact'))
    ok('生成クライアント: exclude のグロブが生成物の走査にも効く');
  else fail('生成クライアント: 除外したはずの場所から生成物を拾っている');
}

// --- パターン B3: A ← B ← C の 3 サービス連鎖。「この API を呼ぶ別サービス」まで遡れるか ---
{
  const model = scan(path.join(patternsDir, 'cross-service'));
  const has = (kind, from, toEnds) =>
    model.edges.some((e) => e.kind === kind && e.from === from && e.to.endsWith(toEnds));

  // メソッドから出る RPC 呼び出しに関数単位の線が付くこと。
  // ここが付かないと、上流をたどっても呼び出し元パッケージで行き止まりになる
  if (has('rpc', 'svc-b#Usecase.Run', 'AService.GetA'))
    ok('3 サービス連鎖: メソッドからの RPC 呼び出しが関数単位で繋がる');
  else fail('メソッドからの呼び出しがパッケージ単位で止まっている');

  // A の RPC → 呼び出し元(B の usecase)→ B のハンドラ →(impl)→ B の RPC → C の関数、と辿れること
  const chain =
    has('rpc', 'svc-b#Usecase.Run', 'AService.GetA') &&
    has('call', 'svc-b#BServer.GetB', 'svc-b#Usecase.Run') &&
    model.edges.some((e) => e.kind === 'impl' && e.from.endsWith('BService.GetB') && e.to === 'svc-b#BServer.GetB') &&
    has('rpc', 'svc-c#Caller.Fetch', 'BService.GetB');
  if (chain) ok('3 サービス連鎖: A の API から、B を越えて C まで遡れる線が揃う');
  else fail('サービス境界を越える上流の連鎖が繋がっていない');

  // mock は呼び出し元として検出される(ビューアの「mock を除外」で落とす対象)
  if (has('rpc', 'svc-b/mocks#MockAServiceClient.GetA', 'AService.GetA'))
    ok('3 サービス連鎖: mock も呼び出し元として現れる(除外フィルタの対象)');
  else fail('mock の呼び出しが検出されていない(フィルタの検証対象が無い)');
}

// --- パターン C: 同じ proto を Go 実装 / TS 呼び出し / Python 呼び出しが囲む ---
{
  const model = scan(path.join(patternsDir, 'polyglot'));
  if (hasRpc(model, 'node-app/search.ts', 'SearchService.Query')) ok('多言語: TS の lowerCamel 呼び出しが繋がる');
  else fail('多言語: TS の呼び出しが繋がらない');
  if (hasRpc(model, 'py-worker', 'SearchService.Suggest')) ok('多言語: Python の Stub 呼び出しが繋がる');
  else fail('多言語: Python の呼び出しが繋がらない');
  if (model.edges.some((e) => e.kind === 'impl' && e.to.endsWith('#server.Query')))
    ok('多言語: Go の実装が impl で繋がる');
  else fail('多言語: Go の実装が繋がらない');
}

// --- パターン D: 同名 service が複数チームの proto にある(取り違えてはいけない) ---
{
  const dir = path.join(patternsDir, 'ambiguous');
  // patterns を外すと決め手が無い: 繋がず、理由つきで未解決に残る
  const bare = scanWithout(dir, 'indirection.patterns');
  if (!rpcEdges(bare).some((e) => e.to.includes('ReportService.Export')))
    ok('同名 service: 決め手が無いので線を引かない');
  else fail('同名 service: 推測で繋いでしまっている');
  const pending = unresolvedOf(bare, 'ReportService.Export');
  if (pending.length === 1 && pending[0].reason === 'artifact' && (pending[0].hint ?? '').includes('複数'))
    ok('同名 service: 理由つきで未解決として残す');
  else fail('同名 service: 未解決として残っていない');

  // manifest を与えると曖昧性が解ける(短名より先に設定を試す)
  const model = scan(dir);
  const edges = rpcEdges(model);
  // 1 つの呼び出しはパッケージ単位と関数単位の両方に線を張るので、本数ではなく行き先で見る
  const targets = new Set(edges.map((e) => e.to));
  if (edges.length > 0 && targets.size === 1 && [...targets][0].includes('team-b/'))
    ok('同名 service: manifest で指した側(team-b)に決着する');
  else fail(`同名 service: manifest で解決できていない (${edges.map((e) => e.to).join(',')})`);
}

// --- パターン E: 同じ service の v1 / v2 が同居し、呼び出し元は v2 の生成物を使う ---
{
  const model = scan(path.join(patternsDir, 'versioned-api'));
  const edges = rpcEdges(model);
  const vTargets = new Set(edges.map((e) => e.to));
  if (edges.length > 0 && vTargets.size === 1 && [...vTargets][0].includes('/v2/'))
    ok('版違い: proto package で v2 を選ぶ');
  else fail(`版違い: v2 に解決されていない (${edges.map((e) => e.to).join(',')})`);
  if (!edges.some((e) => e.to.includes('/v1/'))) ok('版違い: 同名の v1 へは繋がない');
  else fail('版違い: v1 へ誤接続している');
}

// --- パターン F: 手元の proto と、呼び出し元が使う生成物の package が別物 ---
{
  const model = scan(path.join(patternsDir, 'package-collision'));
  const edges = rpcEdges(model);
  const pTargets = new Set(edges.map((e) => e.to));
  if (edges.length > 0 && pTargets.size === 1 && [...pTargets][0].startsWith('artifact:'))
    ok('package 衝突: 提携先の API(生成物側)へ繋ぐ');
  else fail(`package 衝突: 期待した接続でない (${edges.map((e) => e.to).join(',')})`);
  if (!edges.some((e) => e.to.includes('identity.proto')))
    ok('package 衝突: 短名が同じだけの社内 proto へは繋がない');
  else fail('package 衝突: 社内 proto へ誤接続している');
}

// --- パターン G: 同じ変数名で別 service を掴む(スコープを追えないので繋がない) ---
{
  const model = scan(path.join(patternsDir, 'scope-shadowing'));
  if (rpcEdges(model).length === 0) ok('変数の使い回し: どちらの service か決められないので繋がない');
  else fail('変数の使い回し: 推測で繋いでしまっている');
}

// --- パターン H: 自前 Facade 越しの呼び出し(取りこぼすが、誤接続はしない) ---
{
  const model = scan(path.join(patternsDir, 'wrapped-client'));
  if (rpcEdges(model).length === 0) ok('自前ラッパー: 証拠が無いので繋がない(既知の取りこぼし)');
  else fail('自前ラッパー: 根拠なく繋いでいる');
}

// --- パターン J: 手書きの interface / モックを gRPC 呼び出しと誤認しない ---
{
  const model = scan(path.join(patternsDir, 'handwritten-client'));
  if (rpcEdges(model).length === 0) ok('手書きクライアント: 型名が似ているだけでは繋がない');
  else fail('手書きクライアント: 手書き interface を RPC に繋いでしまっている');
  const pending = unresolvedOf(model, 'UserService.GetUser');
  if (pending.length === 1 && (pending[0].hint ?? '').includes('型注釈だけ'))
    ok('手書きクライアント: 繋がなかった理由を残す');
  else fail('手書きクライアント: 未解決の理由が期待どおりでない');
}

// --- パターン K: ストリーミング RPC(呼び出し口はストリームを返すだけ) ---
{
  const model = scan(path.join(patternsDir, 'streaming'));
  const targets = rpcEdges(model).map((e) => e.to).sort();
  if (targets.some((t) => t.endsWith('FeedService.Watch')) && targets.some((t) => t.endsWith('FeedService.Sync')))
    ok('ストリーミング: サーバ / 双方向ストリームの呼び出しを拾う');
  else fail(`ストリーミング: 呼び出しが拾えていない (${targets.join(',')})`);
  if (model.nodes.every((n) => !(n.meta ?? {}).relayCandidate))
    ok('ストリーミング: クライアントラッパーを中継候補と誤認しない');
  else fail('ストリーミング: 中継候補を誤検出している');
}

// --- パターン L: 公開 API と内部 API で RPC 名が変わる Gateway ---
{
  const model = scan(path.join(patternsDir, 'renamed-relay'));
  if (hasRpc(model, 'gateway', 'UserService.GetUser')) ok('名前を変える Gateway: 内部 API への依存を拾う');
  else fail('名前を変える Gateway: 依存が拾えていない');
  if (model.nodes.every((n) => !(n.meta ?? {}).relayCandidate))
    ok('名前を変える Gateway: 素通しではないので中継候補にしない');
  else fail('名前を変える Gateway: 中継候補と誤認している');
}

// --- パターン M: ジェネレータの方言(フルメソッド名を出さない生成物も同定する) ---
{
  const model = scan(path.join(patternsDir, 'generator-dialects'));
  const artifacts = model.nodes.filter((n) => n.kind === 'artifact').map((n) => n.id).sort();
  if (artifacts.length === 3) ok('方言: Go 形式 / connect-es / Elixir の生成物をいずれも署名で同定する');
  else fail(`方言: 同定できた生成物が足りない (${artifacts.join(',')})`);
  if (hasRpc(model, 'app', 'ChatService.Send')) ok('方言: 生成物経由で元 proto の RPC に繋がる');
  else fail('方言: 呼び出しが繋がらない');
}

// --- パターン I: 環境変数で決まるトピック名を IaC(k8s / Helm / Terraform)から逆引きする ---
{
  const dir = path.join(patternsDir, 'event-driven');
  const model = scan(dir);
  const events = model.edges.filter((e) => e.kind === 'event').map((e) => `${e.from}>${e.to}`);
  if (events.includes('svc:order>topic:orders.placed') && events.includes('topic:orders.placed>svc:mailer'))
    ok('IaC 逆引き: k8s と Helm をまたいで publisher と subscriber が繋がる');
  else fail(`IaC 逆引き: publish/subscribe が繋がらない (${events.join(',')})`);

  if (events.includes('svc:billing>topic:payments.captured'))
    ok('IaC 逆引き: Terraform の値を読み、同名変数でもサービスごとに別の値を引く');
  else fail('IaC 逆引き: Terraform の値が読めていない');

  const dynamic = (model.unresolved ?? []).filter((u) => u.reason === 'dynamic');
  if (dynamic.length === 1 && dynamic[0].from === 'svc:report')
    ok('IaC 逆引き: 実行時に組み立てるトピック名は推測せず未解決に残す');
  else fail('IaC 逆引き: 動的生成が未解決として残っていない');

  // IaC に設定の無いサービスへ、別サービスの値を流用しない
  const audit = (model.unresolved ?? []).filter((u) => u.from === 'svc:audit' && u.reason === 'env');
  if (audit.length === 1 && !events.some((e) => e.startsWith('svc:audit>')))
    ok('IaC 逆引き: 設定の無いサービスに他サービスの値を流用しない');
  else fail('IaC 逆引き: 別サービスの環境変数を流用している');

  // opt-in の確認: infra を外すと、接続も未解決も増えない(従来どおり)
  const off = scanWithout(dir, 'infra');
  if (off.edges.every((e) => e.kind !== 'event') && (off.unresolved ?? []).length === 0)
    ok('IaC 逆引き: infra を外すと接続も未解決も増えない(opt-in)');
  else fail(`IaC 逆引き: opt-in が効いていない (未解決 ${(off.unresolved ?? []).length} 件)`);
}

// --- 総合デモ: 生成クライアント + 多段中継 + proto 不在 + 未解決 ---
{
  const model = scan(demoDir);
  if (hasRpc(model, 'services/order', 'UserService.GetUser'))
    ok('デモ: 別配布の生成クライアント越しに実装側の RPC へ繋がる');
  else fail('デモ: 生成クライアント越しの接続がない');

  if (hasRpc(model, 'services/order', 'BillingService.Charge'))
    ok('デモ: proto がワークスペースに無い API を生成物から復元して繋ぐ');
  else fail('デモ: proto 不在の API が復元されていない');

  const relays = model.nodes.filter((n) => (n.meta ?? {}).relayCandidate).map((n) => n.id).sort();
  if (relays.join(',') === 'svc:federation,svc:gateway') ok('デモ: 中継候補を検出して印を付ける');
  else fail(`デモ: 中継候補の検出が期待どおりでない (${relays.join(',')})`);

  const notification = unresolvedOf(model, 'NotificationService.SendReceipt');
  if (notification.length === 1 && notification[0].file.endsWith('server.go'))
    ok('デモ: 手掛かりの無い呼び出しは位置つきで未解決に残す');
  else fail('デモ: 未解決の記録が期待どおりでない');

  if (model.schemaVersion === 3) ok('デモ: モデルに schemaVersion が入る');
  else fail('デモ: schemaVersion がない');
}

// --- トピック名のリテラル抽出: 引用符の中の , や ) を区切りと誤認しない ---
{
  const src = [
    'bus.Publish("tenant,audit", payload)',
    'bus.Publish("result)", payload)',
    'bus.Publish(fmt.Sprintf("%s.%s", a, b), payload)',
  ].join('\n');
  const refs = findTopicRefs(src, ['Publish'], new Map());
  const literals = refs.filter((r) => r.kind === 'literal').map((r) => r.topic).sort();
  if (literals.join('|') === 'result)|tenant,audit') ok('トピック抽出: 引用符内の , と ) を落とさない');
  else fail(`トピック抽出: リテラルが期待どおりでない (${literals.join('|')})`);
  if (refs.some((r) => r.kind === 'dynamic')) ok('トピック抽出: 実行時組み立ては動的として分類する');
  else fail('トピック抽出: 動的生成が分類されていない');
}

// --- 後方互換: schemaVersion を持たない古い model.json を読める ---
{
  const legacy = JSON.stringify({
    tool: 'strata 0.1.0',
    name: 'legacy',
    root: '/tmp/legacy',
    createdAt: '2026-01-01T00:00:00.000Z',
    nodes: [{ id: 'a', label: 'a', kind: 'module' }],
    edges: [],
    warnings: [],
  });
  const parsed = parseGraph(legacy, 'legacy.json');
  if (parsed.schemaVersion === 1 && parsed.unresolved === undefined && parsed.nodes.length === 1)
    ok('後方互換: schemaVersion 無しの model.json を v1 として読む');
  else fail('後方互換: 古い model.json の読み込みが期待どおりでない');
}

if (process.exitCode) console.error('\n間接層テストに失敗があります');
else console.log('\n間接層テスト全件成功');
