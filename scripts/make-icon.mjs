// Strata のアプリアイコン(.icns)を生成する。
//
// ロゴは web/index.html の favicon と同じ「3 層バー」。SVG をラスタライズする外部ツールを
// 増やしたくないので、各サイズを直接ベクタ計算で描いて PNG を自前で書き出す
// (PNG の圧縮は Node 内蔵の zlib だけで足りる)。
//
// 使い方: node scripts/make-icon.mjs <出力先.icns>
// macOS 専用(iconutil を使う)。

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as zlib from 'node:zlib';

// 20x20 のビューボックス上での 3 本のバー(favicon と同じ座標)。
// 上 2 本はティール(地層の上層)、一番下だけアンバーで差し色にする。
const BARS = [
  { x: 2, y: 3.5, w: 16, h: 3.4, r: 1.7, rgb: [0x2d, 0xd4, 0xbf], alpha: 1 },
  { x: 4.5, y: 8.6, w: 11, h: 3.4, r: 1.7, rgb: [0x2d, 0xd4, 0xbf], alpha: 0.55 },
  { x: 7, y: 13.7, w: 6, h: 3.4, r: 1.7, rgb: [0xf5, 0x9e, 0x0b], alpha: 1 },
];
const VIEWBOX = 20;
const SS = 4; // スーパーサンプリング倍率(角丸のギザつきを消す)

// Dock で浮かないよう、macOS のアプリアイコン慣習どおり角丸の下地を敷く
// (角丸半径は一辺の約 22%)。地は UI のダークテーマ面と同じ色にする。
const PLATE = { x: 0, y: 0, w: VIEWBOX, h: VIEWBOX, r: VIEWBOX * 0.223, rgb: [0x0e, 0x21, 0x26], alpha: 1 };
// 下地の内側にバーを収める倍率(周囲に余白を作る)
const GLYPH_SCALE = 0.66;

/** バーを下地の中央へ縮めて配置する。 */
function fitToPlate(bar) {
  const cx = VIEWBOX / 2;
  const cy = VIEWBOX / 2;
  const barsCenterY = (BARS[0].y + BARS[2].y + BARS[2].h) / 2;
  return {
    ...bar,
    x: cx + (bar.x - cx) * GLYPH_SCALE,
    y: cy + (bar.y - barsCenterY) * GLYPH_SCALE,
    w: bar.w * GLYPH_SCALE,
    h: bar.h * GLYPH_SCALE,
    r: bar.r * GLYPH_SCALE,
  };
}

const LAYERS = [PLATE, ...BARS.map(fitToPlate)];

/** 角丸長方形の内側なら true。座標はビューボックス単位。 */
function inRoundRect(x, y, b) {
  if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
  const r = Math.min(b.r, b.w / 2, b.h / 2);
  const cx = Math.min(Math.max(x, b.x + r), b.x + b.w - r);
  const cy = Math.min(Math.max(y, b.y + r), b.y + b.h - r);
  const dx = x - cx;
  const dy = y - cy;
  return dx * dx + dy * dy <= r * r;
}

/** 1 サンプル点をレイヤー順に source-over 合成し、乗算済み RGBA を返す。 */
function sampleAt(vx, vy) {
  let pr = 0;
  let pg = 0;
  let pb = 0;
  let pa = 0;
  for (const layer of LAYERS) {
    if (!inRoundRect(vx, vy, layer)) continue;
    const al = layer.alpha;
    pr = layer.rgb[0] * al + pr * (1 - al);
    pg = layer.rgb[1] * al + pg * (1 - al);
    pb = layer.rgb[2] * al + pb * (1 - al);
    pa = al + pa * (1 - al);
  }
  return [pr, pg, pb, pa];
}

/** size x size の RGBA バッファを描く(下地の外は透明)。 */
function renderRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const scale = VIEWBOX / (size * SS);
  const n = SS * SS;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [sr, sg, sb, sa] = sampleAt((px * SS + sx + 0.5) * scale, (py * SS + sy + 0.5) * scale);
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      const off = (py * size + px) * 4;
      // 乗算済みの合計をアルファの合計で割って、素の色に戻す
      buf[off] = a > 0 ? Math.round(r / a) : 0;
      buf[off + 1] = a > 0 ? Math.round(g / a) : 0;
      buf[off + 2] = a > 0 ? Math.round(b / a) : 0;
      buf[off + 3] = Math.round((a / n) * 255);
    }
  }
  return buf;
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** RGBA バッファを PNG にする(フィルタは None 固定で十分小さい)。 */
function toPng(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: None
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// iconutil が要求する iconset の構成(通常解像度と @2x)
const ENTRIES = [
  [16, 'icon_16x16.png'], [32, 'icon_16x16@2x.png'],
  [32, 'icon_32x32.png'], [64, 'icon_32x32@2x.png'],
  [128, 'icon_128x128.png'], [256, 'icon_128x128@2x.png'],
  [256, 'icon_256x256.png'], [512, 'icon_256x256@2x.png'],
  [512, 'icon_512x512.png'], [1024, 'icon_512x512@2x.png'],
];

export function buildIcns(outIcns) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-icon-'));
  const iconset = path.join(tmp, 'Strata.iconset');
  fs.mkdirSync(iconset);
  const cache = new Map();
  for (const [size, name] of ENTRIES) {
    if (!cache.has(size)) cache.set(size, toPng(renderRgba(size), size));
    fs.writeFileSync(path.join(iconset, name), cache.get(size));
  }
  fs.mkdirSync(path.dirname(outIcns), { recursive: true });
  execFileSync('iconutil', ['-c', 'icns', iconset, '-o', outIcns], { stdio: 'inherit' });
  fs.rmSync(tmp, { recursive: true, force: true });
  return outIcns;
}

if (import.meta.filename === process.argv[1]) {
  const out = process.argv[2] ?? 'dist/app/strata.icns';
  buildIcns(path.resolve(out));
  console.log('アイコンを作成しました: ' + path.resolve(out));
}
