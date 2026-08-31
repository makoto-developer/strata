#!/usr/bin/env node
// Strata CLI(docs/SPEC.md §3.2)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { scan } from './scan.ts';
import { findCycles, trace, type TraceNode } from './graph.ts';
import { checkRules, type RuleViolation } from './rules.ts';
import { buildSarif } from './sarif.ts';
import { computeServiceMetrics } from './metrics.ts';
import { diffModels } from './diff.ts';
import { buildReport } from './report.ts';
import { serve } from './server.ts';
import { exportHtml } from './export.ts';
import { scanAtRef, splitRefRange } from './gitref.ts';
import { parseGraph, TOOL_VERSION } from './model.ts';
import type { Graph, GNode } from './model.ts';

const HELP = `Strata — 多言語・マイクロサービス対応の依存関係可視化・コールグラフ探索ツール

使い方:
  strata scan   [dir] [-o model.json]      解析して依存モデル(JSON)を出力(既定: 標準出力)
  strata serve  [dir|model.json] [--port N] ローカルサーバーでビューアを起動(既定ポート: 7333)
                [--watch]                  ファイル変更でブラウザを自動リロード
  strata export [dir|model.json] [-o report.html] 自己完結 HTML を出力(既定: report.html)
  strata check  [dir|model.json] [--json]  循環依存 + アーキテクチャルールを検出(exit 1、CI 用)
                [--baseline FILE]          既知の循環を許容し、新規の循環だけを検出する
                [--update-baseline]        現在の循環をベースラインとして保存する
                [--sarif] [-o file.sarif]  SARIF 2.1.0 で出力(GitHub Code Scanning 連携)
  strata report [dir|model.json] [-o report.md] アーキテクチャレポート(mermaid + Markdown)を出力
  strata metrics [dir|model.json] [--json]  サービス結合度(Ca/Ce/不安定度)を算出
  strata unresolved [dir|model.json] [--json] 解決できなかった参照を一覧(間接層の設定を書く手掛かり)
  strata diff   <old> <new> [--json]        2 モデルを比較(依存増減・新規/解消の循環)
                [dir] --ref <base>..<head>  2 つの git ref を直接比較(head 省略で作業ツリー)
  strata trace  [dir|model.json] <関数名/ID> [--up] [--depth N] コールツリーを表示
  strata init   [dir] [--force]            strata.config.json の雛形を作成
  strata --version                         バージョンを表示(不具合報告時に添えてください)

共通:
  --ref <git ref>   作業ツリーではなく、その ref の内容を解析する
                    (一時 worktree に取り出すので、いま編集中のファイルには触れない)

対応: Go / TypeScript / JavaScript / Python / Elixir / Protocol Buffers(gRPC)
設定: ワークスペースルートの strata.config.json(docs/SPEC.md 参照)
`;

interface Args {
  command?: string;
  positional: string[];
  options: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { positional: [], options: new Map() };
  let i = 0;
  if (argv.length > 0 && !argv[0].startsWith('-')) {
    args.command = argv[0];
    i = 1;
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-o' || a === '--out' || a === '--port' || a === '--depth' || a === '--baseline' || a === '--ref') {
      args.options.set(a.replace(/^-+/, ''), argv[++i] ?? '');
    } else if (a === '-v') {
      args.options.set('version', true); // よく使われる短縮形だけ受ける
    } else if (a.startsWith('--')) {
      args.options.set(a.slice(2), true);
    } else {
      args.positional.push(a);
    }
  }
  return args;
}

function loadModel(input: string | undefined, ref?: string): Graph {
  const target = input ?? '.';
  if (target.endsWith('.json') && fs.existsSync(target) && fs.statSync(target).isFile()) {
    if (ref) throw new Error('--ref は model.json ではなくディレクトリに対して指定してください');
    return parseGraph(fs.readFileSync(target, 'utf8'), target);
  }
  return ref ? scanAtRef(target, ref) : scan(target);
}

/** コマンド共通の `--ref <git ref>`。指定がなければ undefined。 */
function refOf(args: Args): string | undefined {
  const ref = args.options.get('ref');
  return typeof ref === 'string' && ref !== '' ? ref : undefined;
}

function labelOf(model: Graph, id: string): string {
  return model.nodes.find((n) => n.id === id)?.label ?? id;
}

function printCycles(model: Graph, asJson: boolean): number {
  const cycles = findCycles(model);
  if (asJson) {
    console.log(JSON.stringify({ cycles }, null, 2));
    return cycles.length > 0 ? 1 : 0;
  }
  if (cycles.length === 0) {
    console.log('✓ 循環依存はありません');
    return 0;
  }
  console.log(`✖ 循環依存: ${cycles.length} グループ`);
  for (const c of cycles) {
    const where = c.parent === '' ? '(トップレベル)' : c.parent;
    const members = c.members.map((id) => labelOf(model, id)).join(' ⇄ ');
    console.log(`  [${where}] ${members} (${c.edgeCount} edges)`);
  }
  return 1;
}

// 未解決の理由 → 利用者向けの説明。model.ts の UnresolvedReason と 1 対 1 で対応させる
const UNRESOLVED_LABEL: Record<string, string> = {
  artifact: '生成物から proto 定義を逆引きできなかった',
  env: '環境変数の値が IaC から解決できなかった',
  dynamic: 'トピック名が動的生成されている',
};

/** 未解決参照の一覧。設定を書けば繋がるものを利用者が見つけられるようにする。 */
function printUnresolved(model: Graph, asJson: boolean): void {
  const list = model.unresolved ?? [];
  if (asJson) {
    console.log(JSON.stringify({ unresolved: list }, null, 2));
    return;
  }
  if (list.length === 0) {
    console.log('✓ 未解決の参照はありません');
    return;
  }
  console.log(`未解決の参照: ${list.length} 件\n`);
  const byReason = new Map<string, typeof list>();
  for (const u of list) {
    const bucket = byReason.get(u.reason) ?? [];
    bucket.push(u);
    byReason.set(u.reason, bucket);
  }
  for (const [reason, items] of byReason) {
    console.log(`[${UNRESOLVED_LABEL[reason] ?? reason}] ${items.length} 件`);
    for (const u of items) {
      const where = u.file ? `${u.file}${u.line ? ':' + u.line : ''}` : u.from;
      console.log(`  ${u.detail}  (${where})`);
      if (u.hint) console.log(`    → ${u.hint}`);
    }
    console.log('');
  }
  console.log('繋げたいものが残っている場合は strata.config.json の indirection / infra を設定してください。');
}

function printViolations(model: Graph, violations: RuleViolation[]): void {
  console.error(`✖ アーキテクチャルール違反: ${violations.length} 件`);
  const byRule = new Map<string, RuleViolation[]>();
  for (const v of violations) {
    const key = v.rule.name ?? `${v.rule.from} ↛ ${v.rule.to}`;
    const list = byRule.get(key) ?? [];
    list.push(v);
    byRule.set(key, list);
  }
  for (const [name, list] of byRule) {
    const comment = list[0].rule.comment ? ` — ${list[0].rule.comment}` : '';
    console.error(`\n  [${name}]${comment}`);
    for (const v of list.slice(0, 20)) {
      console.error(`    ${labelOf(model, v.from)} → ${labelOf(model, v.to)} (${v.kind})`);
    }
    if (list.length > 20) console.error(`    …他 ${list.length - 20} 件`);
  }
}

/** strata.config.json の thresholds を評価し、超過メッセージの配列を返す。 */
function checkThresholds(model: Graph): string[] {
  const th = model.thresholds;
  if (!th) return [];
  const out: string[] = [];
  if (typeof th.maxCycles === 'number') {
    const n = findCycles(model).length;
    if (n > th.maxCycles) out.push(`循環グループ ${n} > 上限 ${th.maxCycles}`);
  }
  if (typeof th.maxInstability === 'number' || typeof th.maxEfferent === 'number') {
    for (const m of computeServiceMetrics(model)) {
      if (typeof th.maxInstability === 'number' && m.instability > th.maxInstability + 1e-9)
        out.push(`${m.label}: 不安定度 ${m.instability.toFixed(2)} > ${th.maxInstability}`);
      if (typeof th.maxEfferent === 'number' && m.ce > th.maxEfferent)
        out.push(`${m.label}: 依存先(Ce)${m.ce} > ${th.maxEfferent}`);
    }
  }
  return out;
}

/** 循環グループの同一性キー(ベースライン照合用)。 */
function cycleKey(parent: string, members: string[]): string {
  return parent + '|' + [...members].sort().join('⇄');
}

/**
 * ベースライン方式の check。既知の循環は許容し、新規の循環だけで fail する。
 * 負債が残っているリポジトリでも「これ以上悪化させない」CI を今日から導入できる。
 */
function checkWithBaseline(model: Graph, baselinePath: string, update: boolean): number {
  const cycles = findCycles(model);
  const currentKeys = new Map(cycles.map((c) => [cycleKey(c.parent, c.members), c]));

  if (update) {
    fs.writeFileSync(
      baselinePath,
      JSON.stringify({ tool: model.tool, cycles: [...currentKeys.keys()].sort() }, null, 2) + '\n',
    );
    console.log(`ベースラインを保存しました: ${baselinePath}(循環 ${cycles.length} 件を許容リストに登録)`);
    return 0;
  }

  let known = new Set<string>();
  if (fs.existsSync(baselinePath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(baselinePath, 'utf8')) as { cycles?: string[] };
      known = new Set(parsed.cycles ?? []);
    } catch (err) {
      console.error(`ベースラインの読み込みに失敗しました: ${(err as Error).message}`);
      return 1;
    }
  } else {
    console.error(`ベースラインがありません: ${baselinePath}(--update-baseline で作成できます)`);
    return 1;
  }

  const fresh = [...currentKeys.entries()].filter(([key]) => !known.has(key));
  const resolved = [...known].filter((key) => !currentKeys.has(key));
  if (resolved.length > 0) {
    console.log(`✓ 解消された既知の循環: ${resolved.length} 件(--update-baseline での更新を推奨)`);
  }
  if (fresh.length === 0) {
    console.log(`✓ 新規の循環依存はありません(既知 ${cycles.length} 件は許容中)`);
    return 0;
  }
  console.log(`✖ 新規の循環依存: ${fresh.length} 件`);
  for (const [, c] of fresh) {
    const where = c.parent === '' ? '(トップレベル)' : c.parent;
    console.log(`  [${where}] ${c.members.map((id) => labelOf(model, id)).join(' ⇄ ')} (${c.edgeCount} edges)`);
  }
  return 1;
}

const KIND_MARK: Record<string, string> = {
  service: '◆', module: '▣', package: '□', dir: '▢', file: '·', proto: '⬡', func: 'ƒ', rpc: '⚡',
};

function topAncestor(byId: Map<string, GNode>, id: string): string {
  let cur = byId.get(id);
  while (cur && cur.parent !== undefined && byId.has(cur.parent)) cur = byId.get(cur.parent);
  return cur?.id ?? id;
}

function printTrace(model: Graph, tree: TraceNode): void {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const line = (node: TraceNode, prefix: string, isLast: boolean, isRoot: boolean, parentTop?: string): void => {
    const n = byId.get(node.id);
    const mark = n ? KIND_MARK[n.kind] ?? '·' : '·';
    const meta = n?.meta;
    const loc = meta?.file ? `  (${meta.file}${meta.line ? ':' + meta.line : ''})` : '';
    const top = topAncestor(byId, node.id);
    const boundary =
      parentTop !== undefined && top !== parentTop ? `  ← 境界: ${labelOf(model, top)}` : '';
    const cyc = node.cycle ? '  ↻ 循環' : '';
    const connector = isRoot ? '' : isLast ? '└─ ' : '├─ ';
    console.log(`${prefix}${connector}${mark} ${n?.label ?? node.id}${loc}${boundary}${cyc}`);
    const childPrefix = isRoot ? '' : prefix + (isLast ? '   ' : '│  ');
    node.children.forEach((child, i) =>
      line(child, childPrefix, i === node.children.length - 1, false, top),
    );
  };
  line(tree, '', true, true);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const command = args.command;
  // --version / -v / version: バグ報告に必要なのでバージョンだけを 1 行で出す
  if (command === 'version' || args.options.has('version')) {
    console.log(TOOL_VERSION);
    return;
  }
  if (!command || command === 'help' || args.options.has('help')) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case 'scan': {
      const ref = refOf(args);
      const target = args.positional[0] ?? '.';
      const model = ref ? scanAtRef(target, ref) : scan(target);
      const out = args.options.get('o') ?? args.options.get('out');
      const json = JSON.stringify(model, null, 2);
      if (typeof out === 'string' && out !== '') {
        fs.writeFileSync(out, json);
        console.error(
          `モデルを書き出しました: ${out} (ノード ${model.nodes.length} / エッジ ${model.edges.length})`,
        );
        if (model.warnings.length > 0) console.error(`警告 ${model.warnings.length} 件(モデル内 warnings 参照)`);
      } else {
        console.log(json);
      }
      break;
    }
    case 'init': {
      const dir = args.positional[0] ?? '.';
      const file = path.join(dir, 'strata.config.json');
      if (fs.existsSync(file) && !args.options.has('force')) {
        console.error(`${file} は既に存在します(--force で上書き)`);
        process.exitCode = 1;
        return;
      }
      const template = `{
  // サービスのグルーピング(表示上の最上位階層)。省略時はディレクトリ構造から自動推定
  // "services": [{ "name": "gateway", "path": "gateway" }],

  // グラフから除外するパス(前方一致 or ディレクトリ名)
  // "exclude": ["experimental"],

  // 禁止依存ルール(check で違反すると exit 1)。from/to はグロブ
  "forbidden": [
    // { "name": "domain-no-infra", "from": "**/domain", "to": "**/infra" }
  ],

  // 数値しきい値(超えると check が exit 1)
  "thresholds": {
    "maxCycles": 0
  }

  // 非同期 Pub/Sub 検出(発行/購読メソッド名)
  // , "messaging": { "publish": ["Publish"], "subscribe": ["Subscribe"] }
}
`;
      fs.writeFileSync(file, template);
      console.log(`strata.config.json を作成しました: ${path.resolve(file)}`);
      console.log('forbidden ルールやしきい値を編集し、`strata check` で検査してください。');
      break;
    }
    case 'serve': {
      const input = args.positional[0] ?? '.';
      const port = Number(args.options.get('port') ?? 7333);
      serve(input, port, { watch: args.options.has('watch'), ...(refOf(args) ? { ref: refOf(args)! } : {}) });
      break;
    }
    case 'export': {
      const model = loadModel(args.positional[0], refOf(args));
      const out = (args.options.get('o') as string) || (args.options.get('out') as string) || 'report.html';
      fs.writeFileSync(out, exportHtml(model));
      console.log(`書き出しました: ${path.resolve(out)}`);
      break;
    }
    case 'check': {
      const model = loadModel(args.positional[0], refOf(args));
      const violations = checkRules(model, model.rules);
      // SARIF 出力(GitHub Code Scanning 連携)。テキスト出力の代わりに構造化して出す
      if (args.options.has('sarif')) {
        const cycles = findCycles(model);
        const sarif = buildSarif(model, cycles, violations);
        const out = args.options.get('o') ?? args.options.get('out');
        if (typeof out === 'string' && out !== '') {
          fs.writeFileSync(out, sarif);
          console.error(`SARIF を書き出しました: ${path.resolve(out)}`);
        } else {
          console.log(sarif);
        }
        process.exitCode = cycles.length > 0 || violations.length > 0 ? 1 : 0;
        break;
      }
      const baselinePath = args.options.get('baseline');
      let code = 0;
      if (typeof baselinePath === 'string' && baselinePath !== '') {
        code = checkWithBaseline(model, baselinePath, args.options.has('update-baseline'));
      } else {
        code = printCycles(model, args.options.has('json'));
      }
      // アーキテクチャルール検査(strata.config.json の forbidden)
      if (violations.length > 0) {
        printViolations(model, violations);
        code = 1;
      } else if (model.rules && model.rules.length > 0) {
        console.log(`✅ アーキテクチャルール ${model.rules.length} 件: 違反なし`);
      }
      // 数値しきい値(結合度・循環)の検査
      const breaches = checkThresholds(model);
      if (breaches.length > 0) {
        console.error(`✖ しきい値超過: ${breaches.length} 件`);
        for (const b of breaches) console.error(`  ${b}`);
        code = 1;
      } else if (model.thresholds) {
        console.log('✅ しきい値: 超過なし');
      }
      process.exitCode = code;
      break;
    }
    case 'diff': {
      // --ref base..head を渡すと、その 2 つの ref を一時 worktree に取り出して比較する
      // (head を省くと作業ツリーと比べる)。model.json を 2 つ渡す従来の形も残す。
      const spec = refOf(args);
      const range = spec ? splitRefRange(spec) : null;
      let a: Graph;
      let b: Graph;
      if (spec) {
        const dir = args.positional[0] ?? '.';
        a = scanAtRef(dir, range ? range.base : spec);
        b = range ? scanAtRef(dir, range.head) : loadModel(dir);
      } else if (args.positional.length >= 2) {
        a = loadModel(args.positional[0]);
        b = loadModel(args.positional[1]);
      } else {
        console.error('使い方: strata diff <old: dir|model.json> <new: dir|model.json> [--json]');
        console.error('        strata diff [dir] --ref <base>..<head> [--json]  2 つの git ref を比較');
        console.error('        strata diff [dir] --ref <base> [--json]          ref と作業ツリーを比較');
        process.exitCode = 1;
        return;
      }
      const d = diffModels(a, b);
      if (args.options.has('json')) {
        console.log(JSON.stringify(d, null, 2));
        break;
      }
      const section = (title: string, items: string[], mark: string) => {
        if (items.length === 0) return;
        console.log(`\n${title} (${items.length})`);
        for (const it of items) console.log(`  ${mark} ${it}`);
      };
      console.log(`エッジ変化: +${d.addedEdgeCount} / -${d.removedEdgeCount}`);
      section('新規サービス依存', d.addedServiceDeps, '+');
      section('消えたサービス依存', d.removedServiceDeps, '-');
      section('⚠ 新規に発生した循環', d.newCycles, '+');
      section('✅ 解消された循環', d.resolvedCycles, '-');
      if (
        d.addedServiceDeps.length === 0 &&
        d.removedServiceDeps.length === 0 &&
        d.newCycles.length === 0 &&
        d.resolvedCycles.length === 0
      ) {
        console.log('\nサービス依存・循環に構造的な変化はありません');
      }
      // 新規循環が生まれたら CI で fail できるよう exit 1
      process.exitCode = d.newCycles.length > 0 ? 1 : 0;
      break;
    }
    case 'metrics': {
      const model = loadModel(args.positional[0], refOf(args));
      const metrics = computeServiceMetrics(model);
      if (args.options.has('json')) {
        console.log(JSON.stringify(metrics, null, 2));
        break;
      }
      console.log('サービス結合度メトリクス(Ca=依存される Ce=依存する I=不安定度)\n');
      const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
      // 公開 API 数は gRPC の RPC だけでなく HTTP ルート・GraphQL フィールドも含む
      console.log(pad('service', 22) + pad('Ca', 5) + pad('Ce', 5) + pad('I', 7) + pad('loc', 9) + 'api');
      console.log('─'.repeat(52));
      for (const m of metrics) {
        console.log(
          pad(m.label, 22) +
            pad(String(m.ca), 5) +
            pad(String(m.ce), 5) +
            pad(m.instability.toFixed(2), 7) +
            pad(String(m.loc), 9) +
            String(m.rpc),
        );
      }
      console.log('\nI が高い(不安定)ほど多くに依存し変更の影響を受けやすい。');
      console.log('I が低い(安定)ほど多くに依存され、変更時の影響範囲が広い。');
      break;
    }
    case 'unresolved': {
      const model = loadModel(args.positional[0], refOf(args));
      printUnresolved(model, args.options.has('json'));
      break;
    }
    case 'report': {
      const model = loadModel(args.positional[0], refOf(args));
      const md = buildReport(model);
      const out = args.options.get('o') ?? args.options.get('out');
      if (typeof out === 'string' && out !== '') {
        fs.writeFileSync(out, md);
        console.error(`レポートを書き出しました: ${path.resolve(out)}`);
      } else {
        console.log(md);
      }
      break;
    }
    case 'trace': {
      if (args.positional.length < 1) {
        console.error('使い方: strata trace [dir|model.json] <関数名/ID> [--up] [--depth N]');
        process.exitCode = 1;
        return;
      }
      const query = args.positional[args.positional.length - 1];
      const input = args.positional.length >= 2 ? args.positional[0] : '.';
      const model = loadModel(input, refOf(args));
      let target = model.nodes.find((n) => n.id === query);
      if (!target) {
        const matches = model.nodes.filter(
          (n) =>
            (n.kind === 'func' || n.kind === 'rpc' || n.kind === 'file') &&
            (n.id.includes(query) || n.label.includes(query)),
        );
        if (matches.length === 1) target = matches[0];
        else if (matches.length > 1) {
          console.error(`'${query}' に複数一致しました。ID で指定してください:`);
          for (const m of matches.slice(0, 20)) console.error(`  ${m.id}`);
          process.exitCode = 1;
          return;
        }
      }
      if (!target) {
        console.error(`'${query}' に一致する関数/RPC が見つかりません`);
        process.exitCode = 1;
        return;
      }
      const up = args.options.has('up');
      const depth = Number(args.options.get('depth') ?? 12);
      console.log(up ? '上流(呼び出し元)を表示:' : '下流(呼び出し先)を表示:');
      printTrace(model, trace(model, target.id, up, depth));
      break;
    }
    default:
      console.error(`不明なコマンド: ${command}\n`);
      console.log(HELP);
      process.exitCode = 1;
  }
}

// Node 22.18 未満は TypeScript の type stripping が未対応で、実行前に不明瞭な
// パースエラーになる。起動時に確認して親切なメッセージを出す。
function checkNodeVersion(): void {
  const m = /^v?(\d+)\.(\d+)/.exec(process.versions.node);
  if (!m) return;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 22 || (major === 22 && minor < 18)) {
    console.error(
      `Strata は Node.js 22.18 以上が必要です(現在 ${process.versions.node})。\n` +
        `TypeScript を直接実行するため、より新しい Node を利用してください。`,
    );
    process.exit(1);
  }
}

try {
  checkNodeVersion();
  main();
} catch (err) {
  // scan() や設定読み込みが投げる丁寧な日本語メッセージを、生スタックトレース
  // ではなくそのまま表示する。
  console.error((err as Error).message ?? String(err));
  process.exitCode = 1;
}
