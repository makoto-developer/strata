// macOS のアプリバンドル(Strata.app)と配布用 .dmg を作る。
//
// 中身は scripts/build-binary.mjs が作る単一実行ファイルそのもので、
// 「端末を開かずにダブルクリックで使える」ようにするための薄い皮をかぶせるだけ。
//
// 使い方:
//   node scripts/build-binary.mjs            # 先に dist/bin/strata を作っておく
//   node scripts/build-app.mjs               # → dist/app/Strata.app
//   node scripts/build-app.mjs --dmg         # → dist/app/Strata-macos-arm64.dmg + .sha256
//
// バイナリと同じく ad-hoc 署名のみ(Apple の公証はしていない)。ダウンロード時は
// Gatekeeper の隔離属性が付くため、README の手順で初回だけ右クリック → 開くが要る。

import { execFileSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildIcns } from './make-icon.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const outDir = path.join(root, 'dist', 'app');
const appDir = path.join(outDir, 'Strata.app');
const wantDmg = process.argv.includes('--dmg');

const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: 'inherit', cwd: root, ...opts });

if (process.platform !== 'darwin') {
  console.error('Strata.app のビルドは macOS でのみ行えます(iconutil / hdiutil / codesign が必要)。');
  process.exit(1);
}

const binSrc = path.join(root, 'dist', 'bin', 'strata');
if (!fs.existsSync(binSrc)) {
  console.error('dist/bin/strata がありません。先に `node scripts/build-binary.mjs` を実行してください。');
  process.exit(1);
}

// 1) バンドルの骨格
console.log('▸ bundle layout');
fs.rmSync(appDir, { recursive: true, force: true });
const macosDir = path.join(appDir, 'Contents', 'MacOS');
const resDir = path.join(appDir, 'Contents', 'Resources');
fs.mkdirSync(macosDir, { recursive: true });
fs.mkdirSync(resDir, { recursive: true });

// 実行ファイル(ランチャー)と、その隣に置く本体バイナリ。
// 本体を `strata` にすると、macOS の既定(ケースインセンシティブ)では
// CFBundleExecutable の `Strata` と同じファイル扱いになって上書きされる。
// 名前を分けておくこと(端末から直接叩きたい人にも分かりやすい名前にする)。
fs.copyFileSync(path.join(root, 'dist', 'macos', 'launcher.sh'), path.join(macosDir, 'Strata'));
fs.chmodSync(path.join(macosDir, 'Strata'), 0o755);
fs.copyFileSync(binSrc, path.join(macosDir, 'strata-cli'));
fs.chmodSync(path.join(macosDir, 'strata-cli'), 0o755);

const notices = path.join(root, 'dist', 'bin', 'THIRD-PARTY-NOTICES.txt');
if (fs.existsSync(notices)) fs.copyFileSync(notices, path.join(resDir, 'THIRD-PARTY-NOTICES.txt'));

// 2) アイコン
console.log('▸ icon');
buildIcns(path.join(resDir, 'strata.icns'));

// 3) Info.plist
console.log('▸ Info.plist');
const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Strata</string>
  <key>CFBundleDisplayName</key><string>Strata</string>
  <key>CFBundleIdentifier</key><string>net.makoto-developer.strata</string>
  <key>CFBundleVersion</key><string>${pkg.version}</string>
  <key>CFBundleShortVersionString</key><string>${pkg.version}</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Strata</string>
  <key>CFBundleIconFile</key><string>strata</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>© makoto-developer — AGPL-3.0-only</string>
</dict>
</plist>
`;
fs.writeFileSync(path.join(appDir, 'Contents', 'Info.plist'), plist);
run('plutil', ['-lint', path.join(appDir, 'Contents', 'Info.plist')]);

// 4) ad-hoc 署名(署名しないと「壊れている」と言われて起動できないことがある)
console.log('▸ codesign (ad-hoc)');
run('codesign', ['--force', '--deep', '--sign', '-', appDir]);
run('codesign', ['--verify', '--deep', '--strict', appDir]);

console.log(`できました: ${appDir}`);

// 5) 配布用 dmg(/Applications へのシンボリックリンクを添えて、ドラッグで入れられるようにする)
if (wantDmg) {
  console.log('▸ dmg');
  const stage = path.join(outDir, '.dmg-stage');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  run('cp', ['-R', appDir, path.join(stage, 'Strata.app')]);
  fs.symlinkSync('/Applications', path.join(stage, 'Applications'));
  const dmg = path.join(outDir, 'Strata-macos-arm64.dmg');
  fs.rmSync(dmg, { force: true });
  run('hdiutil', ['create', '-quiet', '-volname', 'Strata', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg]);
  fs.rmSync(stage, { recursive: true, force: true });
  const sum = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
  fs.writeFileSync(dmg + '.sha256', `${sum}  ${path.basename(dmg)}\n`);
  console.log(`できました: ${dmg}`);
}
