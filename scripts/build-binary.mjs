// macOS(Apple Silicon)向けの単一実行ファイル(Node.js SEA)をビルドする。
//
// Strata 本体は実行時依存ゼロだが、SEA は「1 本の CJS ファイル」を要求するため、
// ビルド時だけ esbuild と postject を使う(--no-save で入れて package.json は汚さない)。
//
// 使い方:
//   npm install --no-save esbuild postject
//   node scripts/build-binary.mjs                 # → dist/bin/strata
//   node scripts/build-binary.mjs --tar           # → dist/bin/strata-macos-arm64.tar.gz + .sha256
//
// 生成物は ad-hoc 署名(codesign -s -)のみで、Apple の公証(notarization)はしていない。
// ブラウザでダウンロードすると Gatekeeper の隔離属性が付くため、README の手順で外す。

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

// 埋め込む Node.js。リリースの再現性のためにバージョンを固定する
// (Homebrew 等のディストリビューション版は SEA が無効化されていることがあるため、
//  公式ビルドを取得して使う)。上げるときは README のサポート表も一緒に更新すること。
const NODE_VERSION = process.env.STRATA_NODE_VERSION ?? 'v24.18.0';

const root = fileURLToPath(new URL('..', import.meta.url));
const outDir = path.join(root, 'dist', 'bin');
const workDir = path.join(root, 'dist', '.sea');
const binName = 'strata';
const wantTar = process.argv.includes('--tar');

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

fs.rmSync(workDir, { recursive: true, force: true });
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

// 1) TypeScript を 1 本の CJS にバンドル(型剥がしではなく事前バンドルが必要)
console.log('▸ bundle');
run('npx', [
  'esbuild',
  path.join(root, 'src', 'cli.ts'),
  '--bundle',
  '--platform=node',
  '--format=cjs',
  '--target=node22',
  `--outfile=${path.join(workDir, 'strata.cjs')}`,
]);

// 2) SEA 設定(ビューアの静的資産を埋め込む: 単一ファイルで serve / export が動くように)
const seaConfig = {
  main: path.join(workDir, 'strata.cjs'),
  output: path.join(workDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  assets: {
    'index.html': path.join(root, 'web', 'index.html'),
    'app.js': path.join(root, 'web', 'app.js'),
    'style.css': path.join(root, 'web', 'style.css'),
  },
};
const configPath = path.join(workDir, 'sea-config.json');
fs.writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

// 公式 Node(darwin-arm64)を取得。SEA の blob 生成も、実行ファイルの土台も、これを使う
const nodeDir = path.join(workDir, `node-${NODE_VERSION}-darwin-arm64`);
const nodeBin = path.join(nodeDir, 'bin', 'node');
if (!fs.existsSync(nodeBin)) {
  console.log(`▸ download node ${NODE_VERSION} (darwin-arm64)`);
  const tar = path.join(workDir, 'node.tar.gz');
  run('curl', [
    '-fsSL',
    `https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-darwin-arm64.tar.gz`,
    '-o',
    tar,
  ]);
  run('tar', ['-xzf', tar, '-C', workDir]);
  fs.rmSync(tar, { force: true });
}

console.log('▸ sea blob');
run(nodeBin, [`--experimental-sea-config=${configPath}`]);

// 3) node 本体をコピーし、署名を外して blob を注入 → 再度 ad-hoc 署名
const binPath = path.join(outDir, binName);
console.log('▸ inject');
fs.copyFileSync(nodeBin, binPath);
fs.chmodSync(binPath, 0o755);
try {
  run('codesign', ['--remove-signature', binPath]);
} catch {
  // 署名が無い node ビルドならそのまま進む
}
run('npx', [
  'postject',
  binPath,
  'NODE_SEA_BLOB',
  seaConfig.output,
  '--sentinel-fuse',
  'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  '--macho-segment-name',
  'NODE_SEA',
]);
run('codesign', ['--sign', '-', '--force', binPath]);

// 4) 動作確認(バイナリ自身に解析させる)
console.log('▸ smoke');
const version = execFileSync(binPath, ['--version'], { encoding: 'utf8' }).trim();
execFileSync(binPath, ['scan', path.join(root, 'examples', 'demo'), '-o', path.join(workDir, 'model.json')]);
const model = JSON.parse(fs.readFileSync(path.join(workDir, 'model.json'), 'utf8'));
if (!Array.isArray(model.nodes) || model.nodes.length === 0) throw new Error('scan の出力が空です');
// ビューア資産が埋め込まれているか(export は index.html / app.js / style.css を読む)
const htmlPath = path.join(workDir, 'export.html');
execFileSync(binPath, ['export', path.join(root, 'examples', 'demo'), '-o', htmlPath], { stdio: 'ignore' });
const html = fs.readFileSync(htmlPath, 'utf8');
if (!html.includes('STRATA_MODEL') || !html.includes('#topbar')) {
  throw new Error('export の出力にビューア資産が含まれていません(SEA への埋め込みを確認)');
}

const size = (fs.statSync(binPath).size / 1024 / 1024).toFixed(1);
console.log(`✓ ${binPath} (${size} MB, ${version}, Node ${NODE_VERSION} 同梱)`);

// 5) 配布用の tar.gz + チェックサム
if (wantTar) {
  // Node.js を同梱して配布するため、Node の MIT ライセンス表記を必ず同梱する
  // (MIT は「著作権表示とライセンス文の保持」を条件にしている)。
  const noticeName = 'THIRD-PARTY-NOTICES.txt';
  const nodeLicense = fs.readFileSync(path.join(nodeDir, 'LICENSE'), 'utf8');
  fs.writeFileSync(
    path.join(outDir, noticeName),
    [
      'Strata は AGPL-3.0-only です(LICENSE を参照)。',
      `この実行ファイルには Node.js ${NODE_VERSION} が同梱されています。`,
      'Node.js のライセンスと著作権表示は以下のとおりです。',
      '',
      '='.repeat(78),
      `Node.js ${NODE_VERSION}`,
      '='.repeat(78),
      '',
      nodeLicense,
    ].join('\n'),
  );
  const tarName = `${binName}-macos-arm64.tar.gz`;
  run('tar', ['-czf', path.join(outDir, tarName), '-C', outDir, binName, noticeName]);
  const sum = execFileSync('shasum', ['-a', '256', tarName], { cwd: outDir, encoding: 'utf8' });
  fs.writeFileSync(path.join(outDir, `${tarName}.sha256`), sum);
  console.log(`✓ ${path.join(outDir, tarName)}`);
  console.log(sum.trim());
}
