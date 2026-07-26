// CLI・解析エンジンのスモークテスト。実行: npm test
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.ts';
import { findCycles } from '../src/graph.ts';
import { buildReport } from '../src/report.ts';
import { exportHtml } from '../src/export.ts';
import { parseBlamePorcelain, detectPrNumber } from '../src/server.ts';
import { leadingComment, stripSource } from '../src/lex.ts';
import { parseGraph } from '../src/model.ts';
import { checkRules } from '../src/rules.ts';
import { buildSarif } from '../src/sarif.ts';
import { computeServiceMetrics } from '../src/metrics.ts';
import { diffModels } from '../src/diff.ts';
import { extractEnvVars } from '../src/analyzers/config.ts';

const fail = (msg) => { console.error('✖ ' + msg); process.exitCode = 1; };
const ok = (msg) => console.log('✓ ' + msg);

const demoDir = fileURLToPath(new URL('../examples/demo', import.meta.url));
const cliPath = fileURLToPath(new URL('../src/cli.ts', import.meta.url));
const model = scan(demoDir);

// スキャン結果の要点
if (model.nodes.length > 40 && model.edges.length > 30) ok(`scan: ${model.nodes.length} nodes / ${model.edges.length} edges`);
else fail('scan のノード/エッジが少なすぎる');
if (model.edges.some((e) => e.kind === 'rpc') && model.edges.some((e) => e.kind === 'impl'))
  ok('scan: rpc / impl エッジ(サービス境界の接続)');
else fail('rpc/impl エッジがない');
if (model.edges.some((e) => e.sites && e.sites.length > 0)) ok('scan: 呼び出し箇所(sites)の記録');
else fail('sites がない');
const rpcMetas = model.nodes.filter((n) => n.kind === 'rpc').map((n) => n.meta ?? {});
if (rpcMetas.some((m) => m.deprecated) && rpcMetas.some((m) => m.streaming)) ok('scan: deprecated / streaming の検出');
else fail('deprecated/streaming が検出されていない');
if (model.nodes.some((n) => (n.meta ?? {}).entry === 'main')) ok('scan: エントリーポイント(func main)の検出');
else fail('entry main がない');

// gRPC クライアントラッパー(RPC と同名メソッド)は impl ではなく rpc エッジになること
{
  const byIdRpc = model.nodes.find((n) => n.kind === 'rpc' && n.label === 'UserService.GetUserByID');
  const wrapperId = model.nodes.find((n) => n.id.endsWith('#UserClient.GetUserByID'))?.id;
  const wrapperCalls = model.edges.some(
    (e) => e.kind === 'rpc' && e.from === wrapperId && e.to === byIdRpc?.id,
  );
  const wrapperAsImpl = model.edges.some(
    (e) => e.kind === 'impl' && e.from === byIdRpc?.id && e.to === wrapperId,
  );
  if (byIdRpc && wrapperId && wrapperCalls && !wrapperAsImpl)
    ok('scan: クライアントラッパーを実装と誤認しない(rpc エッジのみ)');
  else fail(`ラッパー判定が想定外(rpc=${wrapperCalls}, impl=${wrapperAsImpl})`);

  // Elixir: get_user_by_id → GetUserByID(頭字語)の突き合わせ
  const exCaller = model.nodes.find((n) => n.id.endsWith('portal.ex#load_user'))?.id;
  const exEdge = model.edges.some(
    (e) => e.kind === 'rpc' && e.from === exCaller && e.to === byIdRpc?.id,
  );
  if (exEdge) ok('scan: Elixir snake_case→頭字語 RPC 名の解決');
  else fail('Elixir の get_user_by_id が GetUserByID に接続されていない');
}

// 説明文(doc コメント)の抽出: proto rpc / Go 関数 / Elixir def
{
  const rpcDoc = model.nodes.find((n) => n.kind === 'rpc' && n.label === 'UserService.GetUser')?.meta?.doc;
  // 同名メソッド(gateway の HTTP ハンドラ)と衝突するため、id を完全一致で引く
  const goDoc = model.nodes.find((n) => n.id === 'services/user/internal/handler#Server.GetUser')?.meta?.doc;
  const exDoc = model.nodes.find((n) => n.id.endsWith('portal.ex#load_user'))?.meta?.doc;
  if (rpcDoc && rpcDoc.includes('1 件取得')) ok('scan: proto rpc の説明文抽出');
  else fail(`proto rpc doc が想定外: ${rpcDoc}`);
  if (goDoc && goDoc.includes('gRPC ハンドラ')) ok('scan: Go 関数の説明文抽出');
  else fail(`Go func doc が想定外: ${goDoc}`);
  if (exDoc && exDoc.includes('初期表示')) ok('scan: Elixir def の説明文抽出');
  else fail(`Elixir doc が想定外: ${exDoc}`);
}

// leadingComment の境界: 直上がコード行末の行内ブロックコメントなら doc として取り込まない
{
  const lines = ['package foo', 'var x = 3 /* trailing */', 'func Bar() {}'];
  const doc = leadingComment(lines, 3); // func Bar は 3 行目
  if (doc === undefined) ok('scan: 行内ブロックコメントを doc に誤取り込みしない');
  else fail(`行内コメント誤取り込み: ${JSON.stringify(doc)}`);
  // 正しいブロック doc は取れる
  const lines2 = ['/**', ' * これは説明です', ' */', 'func Baz() {}'];
  const doc2 = leadingComment(lines2, 4);
  if (doc2 && doc2.includes('これは説明です')) ok('scan: 複数行ブロック doc を抽出');
  else fail(`ブロック doc が想定外: ${JSON.stringify(doc2)}`);
}

// 正規表現リテラルの字句解析: 中の引用符・括弧でクォート/ブレース状態を壊さない
{
  // /['"]/ の後ろのコードが無害化されず、呼び出しが残ること
  const src = `const re = /['"]/;\nfunction f() { helper(); }\n`;
  const { blanked } = stripSource(src, 'js');
  if (blanked.includes('helper(') && blanked.includes('function f()'))
    ok('lex: 正規表現内の引用符でクォート状態に入らない');
  else fail(`正規表現後のコードが無害化された: ${JSON.stringify(blanked)}`);
  // 正規表現の中身(引用符)は無害化される(ブレースマッチを乱さない)
  if (!blanked.includes("'"))
    ok('lex: 正規表現の中身は無害化される');
  else fail('正規表現の中身が残っている');
}
{
  // 除算 `/` は正規表現扱いしない: a / b / c の後の呼び出しが残る
  const src = `function g(a, b) { return a / b / two(); }\n`;
  const { blanked } = stripSource(src, 'js');
  if (blanked.includes('two()') && blanked.includes('a / b'))
    ok('lex: 除算の / を正規表現と誤認しない');
  else fail(`除算が誤って無害化された: ${JSON.stringify(blanked)}`);
}
{
  // 文字クラス [/] 内の / は区切りにならない
  const src = `const m = /[/{]/;\nfunction h() { after(); }\n`;
  const { blanked } = stripSource(src, 'js');
  if (blanked.includes('after(') && blanked.includes('function h()'))
    ok('lex: 正規表現の文字クラス内の / と { を正しく扱う');
  else fail(`文字クラスの扱いで崩れた: ${JSON.stringify(blanked)}`);
}
{
  // キーワード(return)直後の / は正規表現
  const src = `function k() { return /a"b/.test(x); }\nfunction j() { call(); }\n`;
  const { blanked } = stripSource(src, 'js');
  if (blanked.includes('call(') && !blanked.includes('"'))
    ok('lex: return 直後の / を正規表現として扱う');
  else fail(`キーワード後の正規表現で崩れた: ${JSON.stringify(blanked)}`);
}
{
  // Go では / は常に除算/コメントで、正規表現状態に入らない
  const src = `func F() int { return a / b }\n`;
  const { blanked } = stripSource(src, 'go');
  if (blanked.includes('a / b')) ok('lex: Go の / は正規表現化しない');
  else fail('Go の除算が崩れた');
}

// 循環検出
const cycles = findCycles(model);
if (cycles.length === 2) ok('check: 循環 2 グループを検出');
else fail(`循環が ${cycles.length} グループ(期待 2)`);

// レポート生成
const report = buildReport(model);
if (report.includes('```mermaid') && report.includes('user-service') && report.includes('サービス別サマリ'))
  ok('report: mermaid + サマリの生成');
else fail('report の内容が想定外');
if (report.includes('サービス間の呼び出し詳細') && /\| gateway \| .* \| UserService\.GetUser/.test(report))
  ok('report: サービス間の呼び出し詳細(RPC 名の内訳)');
else fail('呼び出し詳細セクションが想定外');

// ベースライン方式の check(CLI 経由)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-test-'));
const baseline = path.join(tmp, 'baseline.json');
try {
  execFileSync(process.execPath, [cliPath, 'check', demoDir, '--baseline', baseline, '--update-baseline'], { stdio: 'pipe' });
  execFileSync(process.execPath, [cliPath, 'check', demoDir, '--baseline', baseline], { stdio: 'pipe' });
  ok('check --baseline: 保存 → 新規なしで exit 0');
} catch (err) {
  fail('check --baseline が失敗: ' + err.message);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// Elixir: 無括弧パイプ・キャプチャ・文字列補間内の呼び出しを検出する
{
  const exDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ex-'));
  fs.writeFileSync(path.join(exDir, 'mix.exs'), 'defmodule Demo.MixProject do\n  use Mix.Project\nend\n');
  fs.writeFileSync(
    path.join(exDir, 'demo.ex'),
    [
      'defmodule Demo do',
      '  def run2(data) do',
      '    data |> validate |> persist',
      '  end',
      '  def run3(list) do',
      '    Enum.map(list, &transform/1)',
      '  end',
      '  def run4(x) do',
      '    build("id-#{persist(x)}")',
      '  end',
      '  def validate(x), do: x',
      '  def persist(x), do: x',
      '  def transform(x), do: x',
      '  def build(x), do: x',
      'end',
      '',
    ].join('\n'),
  );
  try {
    const exModel = scan(exDir);
    const byId = new Map(exModel.nodes.map((n) => [n.id, n]));
    const labelOf = (id) => (byId.get(id) || {}).label;
    const calls = new Set(
      exModel.edges.filter((e) => e.kind === 'call').map((e) => labelOf(e.from) + '->' + labelOf(e.to)),
    );
    const want = ['run2->validate', 'run2->persist', 'run3->transform', 'run4->build', 'run4->persist'];
    const missing = want.filter((w) => !calls.has(w));
    if (missing.length === 0) ok('elixir: 無括弧パイプ/キャプチャ/補間内の呼び出しを検出');
    else fail('elixir 検出漏れ: ' + JSON.stringify(missing) + ' 実際=' + JSON.stringify([...calls]));
  } catch (err) {
    fail('elixir スキャンが失敗: ' + err.message);
  } finally {
    fs.rmSync(exDir, { recursive: true, force: true });
  }
}

// Go: パッケージレベルのクロージャ本体の呼び出しを検出する(ローカルは外側に帰属)
{
  const goDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-go-'));
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module demo\ngo 1.22\n');
  fs.writeFileSync(
    path.join(goDir, 'm.go'),
    [
      'package demo',
      '',
      'var Handler = func(x int) int { return newX(x) }',
      '',
      'func newX(x int) int { return x }',
      '',
      'func normal() {',
      '\tf := func() { helper() }',
      '\tf()',
      '}',
      'func helper() {}',
      '',
    ].join('\n'),
  );
  try {
    const goModel = scan(goDir);
    const byId = new Map(goModel.nodes.map((n) => [n.id, n]));
    const labelOf = (id) => (byId.get(id) || {}).label;
    const calls = goModel.edges.filter((e) => e.kind === 'call').map((e) => labelOf(e.from) + '->' + labelOf(e.to));
    const set = new Set(calls);
    // パッケージレベルクロージャ Handler の本体が走査される
    const hasHandler = set.has('Handler->newX');
    // ローカルクロージャの呼び出しは外側 normal に帰属(重複ノードを作らない)
    const hasNormal = set.has('normal->helper');
    const noDupClosureNode = calls.filter((c) => c === 'Handler->newX').length === 1;
    if (hasHandler && hasNormal && noDupClosureNode)
      ok('go: パッケージレベルクロージャを検出しローカルは外側に帰属');
    else fail('go クロージャ検出が想定外: ' + JSON.stringify(calls));
  } catch (err) {
    fail('go スキャンが失敗: ' + err.message);
  } finally {
    fs.rmSync(goDir, { recursive: true, force: true });
  }
}

// アーキテクチャルール検査: 禁止依存を祖先マッチ + 方向性つきで検出
{
  const g = {
    tool: 'strata',
    name: 't',
    root: '',
    createdAt: '',
    warnings: [],
    nodes: [
      { id: 'app/domain', label: 'domain', kind: 'package' },
      { id: 'app/domain#Do', label: 'Do', kind: 'func', parent: 'app/domain' },
      { id: 'app/infra', label: 'infra', kind: 'package' },
      { id: 'app/infra#Save', label: 'Save', kind: 'func', parent: 'app/infra' },
    ],
    edges: [{ from: 'app/domain#Do', to: 'app/infra#Save', count: 1, kind: 'call' }],
  };
  const rules = [{ name: 'domain-no-infra', from: '**/domain', to: '**/infra' }];
  const v = checkRules(g, rules);
  if (v.length === 1 && v[0].from === 'app/domain#Do') ok('rules: 禁止依存(domain→infra)を関数エッジでも祖先マッチで検出');
  else fail('rule 検出が想定外: ' + JSON.stringify(v));
  const g2 = { ...g, edges: [{ from: 'app/infra#Save', to: 'app/domain#Do', count: 1, kind: 'call' }] };
  if (checkRules(g2, rules).length === 0) ok('rules: 逆方向(infra→domain)は違反にしない');
  else fail('逆方向を誤検出した');
  if (checkRules(g, []).length === 0 && checkRules(g, undefined).length === 0) ok('rules: ルールなしなら違反ゼロ');
  else fail('ルールなしで違反が出た');
}

// 設定サーフェス: Go/JS/Elixir の環境変数読み取りを検出
{
  const go = 'os.Getenv("DB_HOST"); getEnv("PORT", "8080"); os.LookupEnv("DEBUG")';
  const js = 'const a = process.env.API_KEY; const b = process.env["REGION"];';
  const ex = 'System.get_env("SECRET"); System.fetch_env!("HOME")';
  const vars = new Set([...extractEnvVars(go), ...extractEnvVars(js), ...extractEnvVars(ex)]);
  const want = ['DB_HOST', 'PORT', 'DEBUG', 'API_KEY', 'REGION', 'SECRET', 'HOME'];
  const missing = want.filter((v) => !vars.has(v));
  if (missing.length === 0) ok('config: Go/JS/Elixir の環境変数を検出');
  else fail('env 検出漏れ: ' + JSON.stringify(missing) + ' 実際=' + JSON.stringify([...vars]));
}

// 差分分析: 新規サービス依存と新規循環を検出
{
  const mk = (edges) => ({
    tool: 'strata',
    name: 't',
    root: '',
    createdAt: '',
    warnings: [],
    nodes: [
      { id: 'a', label: 'A', kind: 'service' },
      { id: 'a#f', label: 'f', kind: 'func', parent: 'a' },
      { id: 'b', label: 'B', kind: 'service' },
      { id: 'b#g', label: 'g', kind: 'func', parent: 'b' },
    ],
    edges,
  });
  const oldM = mk([]); // 依存なし
  const newM = mk([{ from: 'a#f', to: 'b#g', count: 1, kind: 'call' }]); // A → B が増えた
  const d = diffModels(oldM, newM);
  if (d.addedServiceDeps.includes('A → B') && d.addedEdgeCount === 1 && d.removedServiceDeps.length === 0)
    ok('diff: 新規サービス依存 A→B を検出');
  else fail('diff が想定外: ' + JSON.stringify(d));
  // 逆向きに比較すると削除として出る
  const d2 = diffModels(newM, oldM);
  if (d2.removedServiceDeps.includes('A → B') && d2.removedEdgeCount === 1) ok('diff: 依存の削除も検出');
  else fail('diff 逆方向が想定外: ' + JSON.stringify(d2));
}

// メトリクス: Ca/Ce/不安定度、RPC 依存は実装サービスへ帰属
{
  const model = {
    tool: 'strata',
    name: 't',
    root: '',
    createdAt: '',
    warnings: [],
    nodes: [
      { id: 'a', label: 'A', kind: 'service' },
      { id: 'a#f', label: 'f', kind: 'func', parent: 'a' },
      { id: 'b', label: 'B', kind: 'service' },
      { id: 'b#g', label: 'g', kind: 'func', parent: 'b' },
      { id: 'b#impl', label: 'impl', kind: 'func', parent: 'b' },
      { id: 'c', label: 'C', kind: 'service' },
      { id: 'c#h', label: 'h', kind: 'func', parent: 'c' },
      { id: 'p', label: 'proto', kind: 'proto' },
      { id: 'p#R', label: 'Svc.R', kind: 'rpc', parent: 'p' },
    ],
    edges: [
      { from: 'a#f', to: 'b#g', count: 1, kind: 'call' }, // A → B
      { from: 'c#h', to: 'p#R', count: 1, kind: 'rpc' }, // C → RPC(実装は B)
      { from: 'p#R', to: 'b#impl', count: 1, kind: 'impl' }, // RPC 実装 = B
    ],
  };
  const ms = computeServiceMetrics(model);
  const by = (l) => ms.find((m) => m.label === l);
  const b = by('B');
  const okB = b && b.ca === 2 && b.ce === 0 && b.instability === 0; // A と C から依存される
  const okA = by('A').ce === 1 && by('A').instability === 1;
  const okC = by('C').ce === 1; // RPC 実装帰属で B に依存とカウント
  if (okB && okA && okC) ok('metrics: Ca/Ce/不安定度 + RPC の実装サービス帰属');
  else fail('metrics が想定外: ' + JSON.stringify(ms.map((m) => ({ l: m.label, ca: m.ca, ce: m.ce }))));
}

// SARIF 出力: 循環と違反を SARIF 2.1.0 の results にする
{
  const model = {
    tool: 'strata',
    name: 't',
    root: '',
    createdAt: '',
    warnings: [],
    nodes: [
      { id: 'a', label: 'a', kind: 'package' },
      { id: 'a#f', label: 'f', kind: 'func', parent: 'a', meta: { file: 'a/f.go', line: 3 } },
      { id: 'b', label: 'b', kind: 'package' },
    ],
    edges: [{ from: 'a#f', to: 'b', count: 1, kind: 'call' }],
  };
  const cycles = [{ parent: '', members: ['a', 'b'], edgeCount: 2 }];
  const violations = checkRules(model, [{ name: 'a-no-b', from: 'a', to: 'b' }]);
  const sarif = JSON.parse(buildSarif(model, cycles, violations));
  const okVer = sarif.version === '2.1.0' && Array.isArray(sarif.runs) && sarif.runs.length === 1;
  const ids = sarif.runs[0].results.map((r) => r.ruleId);
  const hasLoc = sarif.runs[0].results.some(
    (r) => r.ruleId === 'a-no-b' && r.locations[0] && r.locations[0].physicalLocation.region.startLine === 3,
  );
  if (okVer && ids.includes('cycle') && ids.includes('a-no-b') && hasLoc)
    ok('sarif: 循環 + 違反を SARIF 2.1.0 として出力(位置つき)');
  else fail('SARIF 出力が想定外: ' + JSON.stringify({ ids, hasLoc }));
}

// モデル JSON の検証: 正しいモデルは通し、壊れた/別形式は明瞭なエラー
{
  const good = parseGraph(JSON.stringify({ tool: 'strata', nodes: [], edges: [] }), 'test');
  if (good.tool === 'strata' && Array.isArray(good.nodes) && Array.isArray(good.warnings))
    ok('model: 正しいモデルを検証して読み込む(欠落フィールドを補完)');
  else fail('正しいモデルの読み込みが想定外: ' + JSON.stringify(good));

  let threwFormat = false;
  try {
    parseGraph(JSON.stringify({ foo: 1 }), 'bad.json');
  } catch (err) {
    threwFormat = /モデルの形式ではありません/.test(err.message);
  }
  if (threwFormat) ok('model: tool/nodes/edges を欠く JSON を明瞭に拒否');
  else fail('別形式 JSON を拒否しなかった');

  let threwJson = false;
  try {
    parseGraph('not json', 'bad2.json');
  } catch (err) {
    threwJson = /正しい JSON ではありません/.test(err.message);
  }
  if (threwJson) ok('model: 不正な JSON を明瞭に拒否');
  else fail('不正 JSON を拒否しなかった');
}

// 非同期(Pub/Sub): config.messaging でトピック経由の依存を検出(既定は無効)
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-msg-'));
  fs.writeFileSync(path.join(ws, 'strata.config.json'), JSON.stringify({ messaging: { publish: ['Publish'], subscribe: ['Subscribe'] } }));
  fs.mkdirSync(path.join(ws, 'producer'));
  fs.writeFileSync(path.join(ws, 'producer', 'go.mod'), 'module producer\ngo 1.22\n');
  fs.writeFileSync(path.join(ws, 'producer', 'm.go'), 'package main\nfunc e(b Bus){ b.Publish("evt.x", d) }\n');
  fs.mkdirSync(path.join(ws, 'consumer'));
  fs.writeFileSync(path.join(ws, 'consumer', 'go.mod'), 'module consumer\ngo 1.22\n');
  fs.writeFileSync(path.join(ws, 'consumer', 'm.go'), 'package main\nfunc l(b Bus){ b.Subscribe("evt.x", h) }\n');
  try {
    const m = scan(ws);
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    const topics = m.nodes.filter((n) => n.kind === 'topic').map((n) => n.label);
    const events = m.edges.filter((e) => e.kind === 'event').map((e) => byId.get(e.from).label + '->' + byId.get(e.to).label);
    if (topics.includes('evt.x') && events.includes('producer->evt.x') && events.includes('evt.x->consumer'))
      ok('messaging: publish/subscribe をトピック経由の event 辺で接続');
    else fail('messaging が想定外: topics=' + JSON.stringify(topics) + ' events=' + JSON.stringify(events));
  } catch (err) {
    fail('messaging スキャンが失敗: ' + err.message);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// Python: 関数/メソッドと同一ファイル内呼び出しを検出(コメント/文字列の罠を無視)
{
  const pyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-py-'));
  fs.writeFileSync(path.join(pyDir, 'pyproject.toml'), '[project]\nname = "demo"\n');
  fs.writeFileSync(
    path.join(pyDir, 'app.py'),
    [
      '"""module"""',
      'def helper(x):',
      '    return x',
      'class Service:',
      '    def run(self, data):',
      '        s = "def fake(): trap"  # def also_fake():',
      '        return helper(self.persist(data))',
      '    def persist(self, data):',
      '        return helper(data)',
      'def main():',
      '    Service().run(1)',
      '',
    ].join('\n'),
  );
  try {
    const pm = scan(pyDir);
    const byId = new Map(pm.nodes.map((n) => [n.id, n]));
    const funcs = new Set(pm.nodes.filter((n) => n.kind === 'func').map((n) => n.label));
    const calls = new Set(
      pm.edges.filter((e) => e.kind === 'call').map((e) => byId.get(e.from).label + '->' + byId.get(e.to).label),
    );
    const okFuncs = funcs.has('Service.run') && funcs.has('Service.persist') && funcs.has('helper') && !funcs.has('fake');
    const okCalls = calls.has('Service.run->Service.persist') && calls.has('main->Service.run');
    if (okFuncs && okCalls) ok('python: メソッド修飾名・self 呼び出し検出、コメント/文字列の罠を無視');
    else fail('python 解析が想定外: funcs=' + JSON.stringify([...funcs]) + ' calls=' + JSON.stringify([...calls]));
  } catch (err) {
    fail('python スキャンが失敗: ' + err.message);
  } finally {
    fs.rmSync(pyDir, { recursive: true, force: true });
  }
}

// Go: gRPC インターセプタ(認可等の横断ミドルウェア)を検出してサービスに付与
{
  const goDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-icept-'));
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module authsvc\ngo 1.22\n');
  fs.mkdirSync(path.join(goDir, 'cmd'));
  fs.writeFileSync(
    path.join(goDir, 'cmd', 'main.go'),
    [
      'package main',
      'import "google.golang.org/grpc"',
      'func main() {',
      '\ts := grpc.NewServer(',
      '\t\tgrpc.ChainUnaryInterceptor(authInterceptor, logging.UnaryServerInterceptor(), recovery.New(cfg)),',
      '\t\tgrpc.StreamInterceptor(streamAuth),',
      '\t)',
      '\t_ = s',
      '}',
      'func authInterceptor() {}',
      '',
    ].join('\n'),
  );
  try {
    const gm = scan(goDir);
    const withIcept = gm.nodes.filter((n) => n.meta && Array.isArray(n.meta.interceptors) && n.meta.interceptors.length);
    const names = withIcept.length ? withIcept[0].meta.interceptors : [];
    const want = ['authInterceptor', 'logging.UnaryServerInterceptor', 'recovery.New', 'streamAuth'];
    const ok1 = withIcept.length === 1 && want.every((w) => names.includes(w));
    if (ok1) ok('go: gRPC インターセプタを検出しサービスに付与');
    else fail('interceptor 検出が想定外: node数=' + withIcept.length + ' names=' + JSON.stringify(names));
  } catch (err) {
    fail('interceptor テストが失敗: ' + err.message);
  } finally {
    fs.rmSync(goDir, { recursive: true, force: true });
  }
}

// proto: 生成スタブと実 proto の重複排除がプロジェクト走査順に依存しない
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-proto-'));
  // 生成スタブ側(名前で先に走査される aaa_gen)
  fs.mkdirSync(path.join(ws, 'aaa_gen'));
  fs.writeFileSync(path.join(ws, 'aaa_gen', 'go.mod'), 'module gencli\ngo 1.22\n');
  fs.writeFileSync(
    path.join(ws, 'aaa_gen', 'user_grpc.pb.go'),
    'package gen\nconst UserService_GetUser_FullMethodName = "/demo.UserService/GetUser"\n',
  );
  // 実 proto 側(後で走査される zzz_proto)
  fs.mkdirSync(path.join(ws, 'zzz_proto'));
  fs.writeFileSync(path.join(ws, 'zzz_proto', 'go.mod'), 'module realproto\ngo 1.22\n');
  fs.writeFileSync(
    path.join(ws, 'zzz_proto', 'user.proto'),
    'syntax = "proto3";\npackage demo;\nservice UserService { rpc GetUser(Req) returns (Res); }\nmessage Req {}\nmessage Res {}\n',
  );
  try {
    const pm = scan(ws);
    const getUserRpcs = pm.nodes.filter((n) => n.kind === 'rpc' && /GetUser$/.test(n.label || ''));
    const dupWarn = (pm.warnings || []).some((w) => /GetUser/.test(w) && /複数/.test(w));
    if (getUserRpcs.length === 1 && !dupWarn)
      ok('proto: 生成スタブ/実 proto の重複排除が走査順に依存しない');
    else
      fail(`proto 重複排除が想定外: rpc数=${getUserRpcs.length} 重複警告=${dupWarn} ids=${JSON.stringify(getUserRpcs.map((n) => n.id))}`);
  } catch (err) {
    fail('proto 重複排除テストが失敗: ' + err.message);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// Go: 型変換 pkg.Type(x) を呼び出しと誤認しない(依存は import 辺が保持)
{
  const goDir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-fp-'));
  fs.writeFileSync(path.join(goDir, 'go.mod'), 'module demo\ngo 1.22\n');
  fs.mkdirSync(path.join(goDir, 'cfg'));
  fs.writeFileSync(path.join(goDir, 'cfg', 'cfg.go'), 'package cfg\n\ntype Duration int\nfunc Load() *Duration { return nil }\n');
  fs.writeFileSync(
    path.join(goDir, 'main.go'),
    'package main\n\nimport "demo/cfg"\n\nfunc run() {\n\td := cfg.Duration(5)\n\t_ = d\n\t_ = cfg.Load()\n}\n',
  );
  try {
    const gm = scan(goDir);
    const byId = new Map(gm.nodes.map((n) => [n.id, n]));
    const labelOf = (id) => (byId.get(id) || {}).label;
    const calls = gm.edges.filter((e) => e.kind === 'call').map((e) => labelOf(e.from) + '->' + labelOf(e.to));
    const imports = gm.edges.filter((e) => e.kind === 'import').map((e) => labelOf(e.from) + '->' + labelOf(e.to));
    const hasRealCall = calls.includes('run->Load');
    const noTypeConvCall = !calls.some((c) => c === 'run->cfg'); // 型変換でパッケージへの call を張らない
    const depKept = imports.some((i) => i.endsWith('->cfg'));
    if (hasRealCall && noTypeConvCall && depKept)
      ok('go: 型変換を call と誤認せず、依存は import 辺で保持');
    else fail(`go 偽陽性抑制が想定外: calls=${JSON.stringify(calls)} imports=${JSON.stringify(imports)}`);
  } catch (err) {
    fail('go 偽陽性テストが失敗: ' + err.message);
  } finally {
    fs.rmSync(goDir, { recursive: true, force: true });
  }
}

// しきい値検査: maxCycles を超えると check が exit 1
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-th-'));
  fs.cpSync(demoDir, tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'strata.config.json'), JSON.stringify({ thresholds: { maxCycles: 0 } }));
  let threw = false;
  try {
    execFileSync(process.execPath, [cliPath, 'check', tmp], { stdio: 'pipe' });
  } catch (err) {
    threw = true;
    const out = String(err.stdout ?? '') + String(err.stderr ?? '');
    if (err.status === 1 && /しきい値超過/.test(out) && /循環グループ/.test(out))
      ok('check: thresholds(maxCycles)超過で exit 1');
    else fail(`thresholds 検査が想定外: status=${err.status} out=${JSON.stringify(out.slice(0, 160))}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (!threw) fail('thresholds 超過で fail しなかった');
}

// クラッシュガード: 不明なディレクトリは整形メッセージ + 生スタックなしで exit 1
{
  let threw = false;
  try {
    execFileSync(process.execPath, [cliPath, 'scan', '/no/such/strata/dir'], { stdio: 'pipe' });
  } catch (err) {
    threw = true;
    const stderr = String(err.stderr ?? '');
    const clean = stderr.includes('ディレクトリが見つかりません') && !/\n\s+at\s/.test(stderr);
    if (err.status === 1 && clean) ok('cli: 不明ディレクトリを整形メッセージで exit 1(生スタックなし)');
    else fail(`不明ディレクトリの扱いが想定外: status=${err.status} stderr=${JSON.stringify(stderr)}`);
  }
  if (!threw) fail('不明ディレクトリでエラー終了しなかった');
}


// HTTP(REST / webhook)検出 §6.9
{
  const node = (pred) => model.nodes.find(pred);
  const edge = (pred) => model.edges.find(pred);
  const getUser = node((n) => n.kind === 'route' && n.label === 'GET /api/users/{}');
  if (getUser && getUser.meta.framework === 'chi' && getUser.meta.file.endsWith('httpapi/router.go'))
    ok('http: chi のルート(Group プレフィックス込み)を検出');
  else fail(`chi ルートが想定外: ${JSON.stringify(getUser)}`);

  const hook = node((n) => n.kind === 'route' && n.label === 'POST /webhooks/payment');
  if (hook && hook.meta.webhook === true) ok('http: webhook 受信口の判定');
  else fail(`webhook 判定が想定外: ${JSON.stringify(hook)}`);
  if (edge((e) => e.kind === 'http' && e.to === hook?.id && e.from.startsWith('ext:http')))
    ok('http: 外部 → webhook 受信口の辺');
  else fail('webhook 受信の外部入口辺がない');

  const crossCall = edge(
    (e) => e.kind === 'http' && e.from.endsWith('#FetchUser') && e.to === getUser?.id,
  );
  if (crossCall && crossCall.sites?.length) ok('http: サービス間 HTTP 呼び出しをルートに接続(呼び出し箇所つき)');
  else fail('order → gateway の HTTP 呼び出しが接続されていない');

  const fromWeb = edge((e) => e.kind === 'http' && e.from.includes('orders-page') && e.to?.includes('POST /api/orders'));
  if (fromWeb) ok('http: fetch(method 指定)から POST ルートへの接続');
  else fail('fetch → POST /api/orders が接続されていない');

  const tmpl = edge(
    (e) => e.kind === 'http' && e.from.endsWith('#fetchUserProfile') && e.to?.includes('GET /api/users/{}'),
  );
  if (tmpl) ok('http: `${BASE}/api/users/${id}` 形式のテンプレート URL を解決');
  else fail('テンプレートリテラルの URL がルートに接続されていない');

  const ext = node((n) => n.kind === 'route' && n.meta?.external && n.label.includes('hooks.example-chat.com'));
  if (ext && edge((e) => e.kind === 'http' && e.to === ext.id && e.from.endsWith('#NotifySlack')))
    ok('http: 未解決の絶対 URL を外部システムノードとして残す(webhook 送信)');
  else fail('外部 webhook 送信先が検出されていない');

  const impl = edge((e) => e.kind === 'impl' && e.from === getUser?.id && e.to.endsWith('#Server.handleGetUser'));
  if (impl) ok('http: ルート → ハンドラ実装の impl 辺');
  else fail('ルートのハンドラ実装が接続されていない');

  // 外部システムは「受信」と「送信」を別ノードにする(1 つにまとめると擬似的な循環になる)
  const inTop = model.nodes.find((n) => n.id === 'ext:http:in');
  const outTop = model.nodes.find((n) => n.id === 'ext:http:out');
  if (inTop && outTop && !model.edges.some((e) => e.from.startsWith('ext:http:out'))) {
    ok('http: 外部システムを受信 / 送信に分離(循環の誤検出を防ぐ)');
  } else fail('外部システムノードの受信/送信分離が想定外');
}

// 禁止依存ルールの照合はパス片単位(部分一致で誤爆しない)
{
  const graph = {
    tool: 'test',
    name: 't',
    root: '/',
    createdAt: '',
    warnings: [],
    nodes: [
      { id: 'web/src/page.ts', label: 'page.ts', kind: 'file' },
      { id: 'ext:http:in:webhook', label: 'Webhook 送信元', kind: 'route' },
      { id: 'services/user', label: 'user', kind: 'module' },
      { id: 'services/user/internal/api', label: 'api', kind: 'package', parent: 'services/user' },
    ],
    edges: [
      { from: 'ext:http:in:webhook', to: 'services/user/internal/api', kind: 'http', count: 1 },
      { from: 'web/src/page.ts', to: 'services/user/internal/api', kind: 'http', count: 1 },
    ],
  };
  const violations = checkRules(graph, [{ name: 'web 直叩き禁止', from: 'web', to: 'services/*' }]);
  if (violations.length === 1 && violations[0].from === 'web/src/page.ts')
    ok('rules: プレーンパターンはパス片単位で照合(web が webhook に誤爆しない)');
  else fail(`ルール照合が想定外: ${JSON.stringify(violations)}`);
}

// GraphQL 検出 §6.10
{
  const node = (pred) => model.nodes.find(pred);
  const edge = (pred) => model.edges.find(pred);
  const q = node((n) => n.kind === 'gqlfield' && n.label === 'Query.user');
  if (q && q.meta.gqlKind === 'query' && q.meta.gqlType.includes('User')) ok('graphql: SDL の Query フィールドを検出');
  else fail(`Query.user が想定外: ${JSON.stringify(q)}`);

  const mut = node((n) => n.kind === 'gqlfield' && n.label === 'Mutation.createOrder');
  if (mut) ok('graphql: Mutation フィールドを検出');
  else fail('Mutation.createOrder が検出されていない');

  if (edge((e) => e.kind === 'impl' && e.from === q?.id && e.to.includes('resolvers.ts')))
    ok('graphql: Apollo リゾルバ実装への impl 辺');
  else fail('リゾルバ実装が接続されていない');

  if (edge((e) => e.kind === 'graphql' && e.from.includes('orders-page') && e.to === mut?.id))
    ok('graphql: クライアントの gql`mutation` からフィールドへの接続');
  else fail('クライアント操作がフィールドに接続されていない');

  if (edge((e) => e.kind === 'graphql' && e.from === 'services/order/schema.graphql' && e.to === 'federation/schema.graphql'))
    ok('graphql: federation の extend type → 所有サブグラフの参照');
  else fail('federation のサブグラフ間参照がない');
}

// GraphQL: ルート直下の選択フィールドだけを拾う(入れ子・引数名・エイリアスに惑わされない)
{
  const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-gqlsel-'));
  fs.writeFileSync(path.join(ws, 'package.json'), '{"name":"gqlsel"}');
  fs.writeFileSync(
    path.join(ws, 'schema.graphql'),
    'type Query {\n  viewer: User\n  shops(term: String, limit: Int): [Shop]\n}\ntype User {\n  id: ID\n  email: String\n}\ntype Shop {\n  id: ID\n  total: Int\n}\n',
  );
  fs.writeFileSync(
    path.join(ws, 'client.js'),
    [
      'export function loadPage() {',
      '  return gql`',
      '    query Page($term: String) {',
      '      viewer {',
      '        id',
      '        email',
      '      }',
      '      mine: shops(term: $term, limit: 10) {',
      '        total',
      '      }',
      '    }',
      '  `;',
      '}',
      '',
    ].join('\n'),
  );
  try {
    const m = scan(ws);
    const byId = new Map(m.nodes.map((n) => [n.id, n]));
    const hit = new Set(
      m.edges.filter((e) => e.kind === 'graphql').map((e) => byId.get(e.to)?.label),
    );
    // viewer と shops の両方に繋がり、入れ子(id/email/total)や引数名(term/limit)には繋がらない
    const wanted = hit.has('Query.viewer') && hit.has('Query.shops');
    const noise = ['id', 'email', 'total', 'term', 'limit', 'mine'].some((n) =>
      [...hit].some((label) => label?.endsWith('.' + n)),
    );
    if (wanted && !noise) ok('graphql: ルート直下の選択だけを接続(入れ子・引数名・エイリアスを除外)');
    else fail('graphql の選択解析が想定外: ' + JSON.stringify([...hit]));
  } catch (err) {
    fail('graphql 選択スキャンが失敗: ' + err.message);
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

// 自己完結 HTML(export)の健全性 §8.4
{
  const html = exportHtml(model);
  const closes = (html.match(/<\/script/g) ?? []).length;
  if (closes === 2) ok('export: script タグが途中で閉じない(モデル + app.js の 2 つだけ)');
  else fail(`export の </script> が ${closes} 個ある(正常は 2)。置換で app.js の中身が壊れている`);

  if (!html.includes('<script src="app.js">')) ok('export: 元の script 参照が残らない');
  else fail('export に <script src="app.js"> が残っている(置換文字列の $& 展開の疑い)');

  // インラインの JSON が元のモデルに戻せるか(< のエスケープが JSON を壊していないか)
  const m = /window\.STRATA_MODEL = ([\s\S]*?);<\/script>/.exec(html);
  if (m) {
    const revived = JSON.parse(m[1].replace(/\\u003c/g, '<'));
    if (revived.nodes.length === model.nodes.length) ok('export: インライン化したモデルが復元できる');
    else fail(`export のモデルが壊れている: ${revived.nodes.length} != ${model.nodes.length}`);
  } else {
    fail('export に window.STRATA_MODEL が見つからない');
  }

  // 解析対象のコードに $& や </script> が含まれていても壊れないこと
  const hostile = {
    ...model,
    nodes: [
      ...model.nodes,
      { id: 'hostile', label: '$& </script><script>alert(1)</script>', kind: 'file', meta: { doc: "$'$`$1" } },
    ],
  };
  const hostileHtml = exportHtml(hostile);
  const hostileCloses = (hostileHtml.match(/<\/script/g) ?? []).length;
  if (hostileCloses === 2 && !hostileHtml.includes('<script>alert(1)</script>')) {
    ok('export: ノード名の $& / </script> を無害化できる');
  } else {
    fail(`敵対的なノード名で export が壊れる(</script> ${hostileCloses} 個)`);
  }
}

// バージョンの一貫性(package.json / TOOL_VERSION / --version)
{
  const pkg = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'));
  const shown = execFileSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' }).trim();
  if (shown === `strata ${pkg.version}` && model.tool === `strata ${pkg.version}`) {
    ok(`version: package.json / --version / モデルの tool が一致(${pkg.version})`);
  } else {
    fail(`version 不一致: package.json=${pkg.version} --version=${shown} model.tool=${model.tool}`);
  }
}

// git 連携のパーサ
const sampleSha = 'a'.repeat(40);
const porcelain = [
  `${sampleSha} 1 1 2`,
  'author Alice',
  'author-time 1700000000',
  'summary add feature',
  '\tline one',
  `${sampleSha} 2 2`,
  '\tline two',
].join('\n');
const blame = parseBlamePorcelain(porcelain);
if (blame.length === 2 && blame[0].author === 'Alice' && blame[1].line === 2 && blame[1].summary === 'add feature')
  ok('git: blame porcelain のパース');
else fail('blame パースが想定外: ' + JSON.stringify(blame));
if (
  detectPrNumber('機能追加 (#123)', '') === 123 &&
  detectPrNumber('Merge pull request #45 from x/y', '') === 45 &&
  detectPrNumber('plain commit', '') === null
)
  ok('git: PR 番号の検出');
else fail('PR 番号検出が想定外');

console.log(process.exitCode ? '\nCLI テスト失敗あり' : '\nCLI テスト全件成功');
