// 解析結果(モデル)の回帰検査。
//
// このツールの怖い壊れ方は「例外も出ず、テストも通り、絵だけが静かに間違う」こと。
// 実際、生成クライアント構成でサーバ実装が繋がらない・メソッドからの RPC 呼び出しが
// 関数に紐づかない、といった誤りが型検査もテストも素通りしていた。
// モデルは同じ入力なら決定的なので、期待値を丸ごと固定して差分ゼロを要求する。
//
//   node scripts/golden.mjs           検証(差分があれば exit 1)
//   node scripts/golden.mjs --update  期待値を更新(差分を確認してからコミットする)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { scan } from '../src/scan.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const goldenDir = path.join(root, 'test', 'golden');
const update = process.argv.includes('--update');

/** 環境で変わる値(絶対パス・時刻・版)を落とす。それ以外は全部比較する。 */
function normalize(model) {
  const { tool, root: _root, createdAt, ...rest } = model;
  return rest;
}

function targets() {
  const out = [{ name: 'demo', dir: path.join(root, 'examples', 'demo') }];
  const patterns = path.join(root, 'test', 'fixtures', 'patterns');
  for (const name of fs.readdirSync(patterns).sort()) {
    const dir = path.join(patterns, name);
    if (fs.statSync(dir).isDirectory()) out.push({ name, dir });
  }
  return out;
}

/** 差分を人が読める形にする(生 JSON を並べても原因が分からない)。 */
function describe(expected, actual) {
  const lines = [];
  const key = (e) => `${e.kind} ${e.from} → ${e.to}`;
  const setOf = (arr, f) => new Set(arr.map(f));

  const en = setOf(expected.nodes, (n) => `${n.kind} ${n.id}`);
  const an = setOf(actual.nodes, (n) => `${n.kind} ${n.id}`);
  const ee = setOf(expected.edges, key);
  const ae = setOf(actual.edges, key);
  const diff = (a, b) => [...a].filter((x) => !b.has(x)).sort();

  for (const [label, list] of [
    ['消えたノード', diff(en, an)],
    ['増えたノード', diff(an, en)],
    ['消えたエッジ', diff(ee, ae)],
    ['増えたエッジ', diff(ae, ee)],
    ['消えた警告', diff(new Set(expected.warnings), new Set(actual.warnings))],
    ['増えた警告', diff(new Set(actual.warnings), new Set(expected.warnings))],
  ]) {
    if (list.length === 0) continue;
    lines.push(`    ${label} ${list.length} 件:`);
    for (const x of list.slice(0, 8)) lines.push(`      ${x}`);
    if (list.length > 8) lines.push(`      …他 ${list.length - 8} 件`);
  }
  // ノード・エッジ・警告が同じでも中身(meta や count)が違うことはある
  if (lines.length === 0) lines.push('    ノード・エッジ・警告の集合は同じですが、中身(meta / count / sites)が違います');
  return lines.join('\n');
}

fs.mkdirSync(goldenDir, { recursive: true });
let failed = 0;
let updated = 0;
for (const { name, dir } of targets()) {
  const actual = normalize(JSON.parse(JSON.stringify(scan(dir))));
  const file = path.join(goldenDir, `${name}.json`);
  const text = JSON.stringify(actual, null, 2) + '\n';
  if (update) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (before !== text) {
      fs.writeFileSync(file, text);
      updated++;
      console.log(`✎ ${name}`);
    }
    continue;
  }
  if (!fs.existsSync(file)) {
    console.error(`✖ ${name}: 期待値がありません(node scripts/golden.mjs --update で作成)`);
    failed++;
    continue;
  }
  const expected = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (JSON.stringify(expected) === JSON.stringify(actual)) {
    console.log(`✓ ${name}(ノード ${actual.nodes.length} / エッジ ${actual.edges.length})`);
    continue;
  }
  console.error(`✖ ${name}: 解析結果が期待値と違います`);
  console.error(describe(expected, actual));
  failed++;
}

if (update) {
  console.log(updated === 0 ? '\n期待値に変更はありません' : `\n期待値を ${updated} 件更新しました(差分を確認してからコミットしてください)`);
} else if (failed > 0) {
  console.error(
    `\nゴールデンモデル検査 失敗 ${failed} 件。` +
      '\n意図した変更なら node scripts/golden.mjs --update で更新し、差分をレビューしてからコミットしてください。',
  );
  process.exitCode = 1;
} else {
  console.log('\nゴールデンモデル検査 全件一致');
}
