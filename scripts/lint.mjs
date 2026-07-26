// このリポジトリの約束事を機械的に検査する簡易リンター。
//
//   node scripts/lint.mjs        # 違反があれば一覧を出して exit 1
//
// ESLint 等を入れないのは「実行時依存ゼロ・開発でも npm install 不要」を保つため。
// 汎用の整形ルールではなく、**このプロジェクトが実際に守りたいこと**だけを見る。
//
// 検査内容:
//   1. 行末の空白 / タブインデント(インデントは 2 スペース)
//   2. `any` の使用(型安全の方針。どうしても必要なら理由コメントを直前行に書く)
//   3. デバッグの置き忘れ(debugger / console.log)。CLI の出力は許可リストで除外
//   4. TODO / FIXME(作業メモはコード内ではなく Issue に置く)
//   5. src/*.ts の冒頭コメント(そのモジュールの役割を 1 行目に書く慣習)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const problems = [];
const add = (file, line, msg) => problems.push(`${path.relative(root, file)}:${line}: ${msg}`);

/** 検査対象を集める(生成物・依存・フィクスチャは対象外)。 */
function collect(dir, exts, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(p, exts, out);
    else if (exts.some((e) => entry.name.endsWith(e))) out.push(p);
  }
  return out;
}

const SELF = path.join(root, 'scripts', 'lint.mjs'); // ルール定義の文字列に自分で反応しないよう除外
const files = [
  ...collect(path.join(root, 'src'), ['.ts']),
  ...collect(path.join(root, 'web'), ['.js']),
  ...collect(path.join(root, 'scripts'), ['.mjs']),
  ...collect(path.join(root, 'test'), ['.mjs']),
].filter((f) => f !== SELF);

// console.log を許可するファイル(CLI の出力・サーバの起動ログ・開発スクリプト)
const CONSOLE_OK = [/^src\/cli\.ts$/, /^src\/server\.ts$/, /^scripts\//, /^test\//];

for (const file of files) {
  const rel = path.relative(root, file);
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');

  // shebang があるファイルは 2 行目を見る
  const headLine = /^#!/.test(lines[0] ?? '') ? (lines[1] ?? '') : (lines[0] ?? '');
  if (rel.startsWith('src/') && !/^\s*(\/\/|\/\*)/.test(headLine)) {
    add(file, 1, 'ファイル冒頭にモジュールの役割を説明するコメントがありません');
  }

  lines.forEach((line, i) => {
    const n = i + 1;
    if (/[ \t]+$/.test(line)) add(file, n, '行末に空白があります');
    if (/^\t/.test(line)) add(file, n, 'タブでインデントされています(2 スペースに揃えてください)');
    if (/\bdebugger\b/.test(line)) add(file, n, 'debugger が残っています');
    if (/\bconsole\.log\(/.test(line) && !CONSOLE_OK.some((re) => re.test(rel))) {
      add(file, n, 'console.log が残っています(ユーザー向け出力は cli.ts に集約してください)');
    }
    if (/\b(TODO|FIXME|XXX)\b/.test(line)) {
      add(file, n, '作業メモ(TODO / FIXME)はコードではなく Issue に置いてください');
    }
    // `any` は型安全の方針で原則禁止。直前行に理由コメントがあれば許可する
    if (rel.endsWith('.ts') && /(:\s*any\b|\bas\s+any\b|<any>)/.test(line)) {
      const prev = lines[i - 1] ?? '';
      if (!/^\s*(\/\/|\*)/.test(prev)) {
        add(file, n, 'any を使う場合は直前行に理由をコメントしてください');
      }
    }
  });
}

if (problems.length > 0) {
  console.error(`✖ ${problems.length} 件の指摘があります\n`);
  for (const p of problems) console.error('  ' + p);
  console.error('\n(意図的な例外は scripts/lint.mjs の許可リストに追記してください)');
  process.exit(1);
}
console.log(`✓ ${files.length} ファイルを検査しました。指摘はありません`);
