// 解析結果(Graph)のキャッシュ。
//
// serve は model.json のリクエストごとに解析し直していた。100 リポジトリのワークスペースで
// 毎回 9 秒かかり、ブラウザを開き直すたびにその時間を払う。
//
// 有効性の判定は「指紋」の一致で行う。指紋は解析対象ファイルのパス・サイズ・更新時刻に加え、
// strata 自身の解析コードの状態からも作る。ディレクトリを走査して stat するだけで
// 中身は読まないので、本解析より 1〜2 桁速い。
//
// 自分のソースを混ぜるのは、版番号だけだと開発中やソース実行で解析コードを直しても
// 指紋が変わらず、古い結果を返し続けるため。実際にそれで取りこぼしを起こした。
//
// 指紋(小さい)とモデル(大きい)はファイルを分ける。判定は指紋だけ読めば済み、
// 一致したときにモデル本体を 1 回だけ読む。

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SKIP_DIRS } from './context.ts';
import { parseGraph, TOOL_VERSION, type Graph } from './model.ts';

/**
 * strata 自身の解析コードの状態。
 *
 * 版番号だけでは、開発中やソース実行(node src/cli.ts)で解析コードを直しても
 * 指紋が変わらず、古い結果を返し続ける。実際にそれで「新しく足した項目が
 * 出ない」という取りこぼしを起こした。自分のソースの更新時刻も指紋に混ぜる。
 * パッケージ版(SEA)にはソースが無いので、その場合は版番号だけで十分
 * (リリースごとに変わり、中身は不変なため)。
 */
function toolDigest(): string {
  const hash = crypto.createHash('sha1').update(TOOL_VERSION);
  try {
    const srcDir = fileURLToPath(new URL('.', import.meta.url));
    for (const dir of [srcDir, path.join(srcDir, '..', 'web')]) {
      const walk = (d: string): void => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const abs = path.join(d, e.name);
          if (e.isDirectory()) walk(abs);
          else if (e.isFile()) {
            const st = fs.statSync(abs);
            hash.update(`${e.name} ${st.size} ${st.mtimeMs}\n`);
          }
        }
      };
      walk(dir);
    }
  } catch {
    // ソースが無い(パッケージ版)。版番号だけで判定する
  }
  return hash.digest('hex').slice(0, 16);
}

/** 走査対象ファイルの要約。1 つでも変われば解析結果も変わりうる。 */
export interface Fingerprint {
  tool: string; // 解析ロジック(版 + 自身のソース)が変われば作り直す
  files: number;
  bytes: number;
  // パス・サイズ・更新時刻から作る。件数と合計サイズだけでは
  // 「1 バイト増えたファイルと 1 バイト減ったファイル」の組み合わせで衝突する
  digest: string;
}

const CACHE_DIR = path.join(
  process.env.STRATA_CONFIG_DIR
    ? path.resolve(process.env.STRATA_CONFIG_DIR)
    : path.join(os.homedir(), '.config', 'strata'),
  'cache',
);
const KEEP = 12; // 保持するワークスペース数(古いものから捨てる)
const MAX_MODEL_BYTES = 128 * 1024 * 1024; // これを超えるモデルは置かない(読み出しで全量をメモリに載せる)
const MAX_TOTAL_BYTES = 512 * 1024 * 1024; // キャッシュ全体の上限。件数だけでは HOME を圧迫しうる

const keyOf = (rootAbs: string): string =>
  crypto.createHash('sha1').update(path.resolve(rootAbs)).digest('hex').slice(0, 16);
const metaFile = (rootAbs: string): string => path.join(CACHE_DIR, `${keyOf(rootAbs)}.meta.json`);
const modelFile = (rootAbs: string): string => path.join(CACHE_DIR, `${keyOf(rootAbs)}.model.json`);

/**
 * 解析対象ディレクトリの指紋を取る。
 * SKIP_DIRS(.git / node_modules / vendor 等)は解析対象外なので数えない。
 * ワークスペース直下のシンボリックリンク(複合プロジェクト)は scan と同じく辿る。
 */
export function fingerprint(rootAbs: string): Fingerprint {
  const root = path.resolve(rootAbs);
  const hash = crypto.createHash('sha1');
  let files = 0;
  let bytes = 0;
  const visit = (dirAbs: string, depth: number): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return; // 読めないディレクトリは無視(解析側も同じ)
    }
    // 走査順が環境で変わると同じ状態でも指紋が変わるので名前順に固定する
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childAbs = path.join(dirAbs, entry.name);
      let isDir = entry.isDirectory();
      if (!isDir && depth === 0 && entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(childAbs).isDirectory();
        } catch {
          continue; // リンク切れ
        }
      }
      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(childAbs, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      try {
        const st = fs.statSync(childAbs);
        files++;
        bytes += st.size;
        hash.update(`${path.relative(root, childAbs)} ${st.size} ${st.mtimeMs}\n`);
      } catch {
        // 走査中に消えたファイルは数えない
      }
    }
  };
  visit(root, 0);
  return { tool: toolDigest(), files, bytes, digest: hash.digest('hex') };
}

/** 指紋が同じ = 解析し直しても同じ結果になるとみなせる。 */
export function sameFingerprint(a: Fingerprint, b: Fingerprint): boolean {
  return a.tool === b.tool && a.files === b.files && a.bytes === b.bytes && a.digest === b.digest;
}

/** 指紋が一致するキャッシュがあれば返す。無ければ null(呼び出し側で解析する)。 */
export function readCache(rootAbs: string, fp: Fingerprint): Graph | null {
  try {
    const saved = JSON.parse(fs.readFileSync(metaFile(rootAbs), 'utf8')) as Fingerprint;
    if (!sameFingerprint(saved, fp)) return null;
    const file = modelFile(rootAbs);
    if (fs.statSync(file).size > MAX_MODEL_BYTES) return null;
    const graph = parseGraph(fs.readFileSync(file, 'utf8'), file);
    // 最終利用時刻を更新して、間引きで「使われていないもの」から消せるようにする
    try {
      const now = new Date();
      fs.utimesSync(file, now, now);
      fs.utimesSync(metaFile(rootAbs), now, now);
    } catch {
      // 更新できなくても読み出しは成立している
    }
    return graph;
  } catch {
    return null; // 無い・壊れている・形式が古い
  }
}

/** 解析結果を保存する。失敗しても解析自体は成立しているので握りつぶす。 */
export function writeCache(rootAbs: string, fp: Fingerprint, graph: Graph): void {
  try {
    const text = JSON.stringify(graph);
    if (Buffer.byteLength(text) > MAX_MODEL_BYTES) {
      clearCache(rootAbs); // 古い結果を残すと指紋不一致のまま容量だけ食う
      return;
    }
    // モデルにはリポジトリの絶対パスと構成が入るので、他ユーザーからは読めないようにする
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    fs.chmodSync(CACHE_DIR, 0o700); // 既存ディレクトリには mkdir の mode が効かない
    // モデル → 指紋 の順に確定させる(指紋があるのに本体が無い状態を作らない)
    writeAtomic(modelFile(rootAbs), text);
    writeAtomic(metaFile(rootAbs), JSON.stringify(fp));
    prune();
  } catch {
    // 書けない環境(読み取り専用 HOME 等)でもキャッシュ無しで動く
  }
}

function writeAtomic(file: string, text: string): void {
  // 予測できる名前だと先回りして作られうるので、乱数名 + 排他作成(wx)にする
  const tmp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tmp, text, { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true }); // 失敗した一時ファイルを溜めない
    throw e;
  }
}

/** 指定ワークスペースのキャッシュを捨てる。 */
export function clearCache(rootAbs: string): void {
  for (const file of [metaFile(rootAbs), modelFile(rootAbs)]) {
    try {
      fs.rmSync(file, { force: true });
    } catch {
      // 消せなくても指紋が合わなければ使われない
    }
  }
}

function entryBytes(key: string): number {
  let total = 0;
  for (const name of [`${key}.meta.json`, `${key}.model.json`]) {
    try {
      total += fs.statSync(path.join(CACHE_DIR, name)).size;
    } catch {
      // 片割れが無いだけなので 0 として扱う
    }
  }
  return total;
}

/** 使われていないキャッシュを間引く。件数と総容量の両方で頭を打たせる。 */
function prune(): void {
  try {
    const keys = fs
      .readdirSync(CACHE_DIR)
      .filter((n) => n.endsWith('.meta.json'))
      .map((n) => {
        const key = n.slice(0, -'.meta.json'.length);
        return { key, mtimeMs: fs.statSync(path.join(CACHE_DIR, n)).mtimeMs, bytes: entryBytes(key) };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    let total = 0;
    for (const [i, k] of keys.entries()) {
      total += k.bytes;
      if (i < KEEP && total <= MAX_TOTAL_BYTES) continue;
      fs.rmSync(path.join(CACHE_DIR, `${k.key}.meta.json`), { force: true });
      fs.rmSync(path.join(CACHE_DIR, `${k.key}.model.json`), { force: true });
      total -= k.bytes;
    }
  } catch {
    // 間引けなくても動作に影響はない
  }
}
