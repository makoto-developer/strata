// git ref を一時 worktree に取り出して解析する(docs/SPEC.md §9.3)。
//
// 作業ツリーを汚さずに「別ブランチ / タグ / コミットの依存モデル」を得るための仕組み。
// git worktree は .git を共有するので clone より速く、ディスクも食わない。
// git はすべて execFile 系(シェル非経由)で呼ぶ。

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { scan } from './scan.ts';
import type { Graph } from './model.ts';

/**
 * ref として受け付ける形。シェルは経由しないが、`-` 始まりは git のオプションと
 * 解釈されうるので弾く(`--upload-pack=...` 型の混入を防ぐ)。
 */
const REF_PATTERN = /^[A-Za-z0-9][\w./@^~+-]{0,200}$/;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * dir が属する git リポジトリのルート。git 管理外なら null。
 * git はシンボリックリンクを解決した実パスを返すので(macOS の /var → /private/var 等)、
 * 呼び出し側のパスと突き合わせるときは両方を実パスに揃えること。
 */
export function repoRootOf(dir: string): string | null {
  try {
    return git(dir, ['rev-parse', '--show-toplevel']);
  } catch {
    return null;
  }
}

/** シンボリックリンクを解決した絶対パス。解決できなければ path.resolve の結果。 */
function realPath(p: string): string {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch {
    return path.resolve(p);
  }
}

/** ref をコミット SHA に解決する。解決できなければ理由つきで投げる。 */
export function resolveRef(root: string, ref: string): string {
  if (!REF_PATTERN.test(ref)) {
    throw new Error(`ref の形式が不正です: ${ref}(英数字で始まる git の参照名を指定してください)`);
  }
  try {
    return git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]);
  } catch {
    throw new Error(`ref を解決できません: ${ref}(このリポジトリに存在しない、または未フェッチ)`);
  }
}

/**
 * ref の内容を一時 worktree に取り出し、fn に「dir に対応するパス」を渡す。
 * dir がリポジトリのサブディレクトリなら、worktree 側の同じサブディレクトリを渡す。
 * fn の成否にかかわらず worktree は必ず片付ける。
 */
export function withWorktree<T>(dir: string, ref: string, fn: (checkout: string) => T): T {
  const root = repoRootOf(dir);
  if (root === null) throw new Error(`git リポジトリではありません: ${dir}(--ref は git 管理下でのみ使えます)`);
  const sha = resolveRef(root, ref);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-ref-'));
  const checkout = path.join(tmp, 'tree');
  try {
    git(root, ['worktree', 'add', '--detach', '--quiet', checkout, sha]);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw new Error(`worktree を作成できません(${ref}): ${(err as Error).message.split('\n')[0]}`);
  }
  // 実パスに揃えてから相対化する。揃えないと macOS の /var → /private/var のずれで
  // `../..` を含む相対パスになり、worktree ではなく元の作業ツリーを解析してしまう。
  const sub = path.relative(realPath(root), realPath(dir));
  try {
    if (sub.startsWith('..') || path.isAbsolute(sub)) {
      throw new Error(`解析対象がリポジトリの外にあります: ${dir}`);
    }
    return fn(sub === '' ? checkout : path.join(checkout, sub));
  } finally {
    try {
      git(root, ['worktree', 'remove', '--force', checkout]);
    } catch {
      // worktree の登録解除に失敗しても、実体は下で消す
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    try {
      git(root, ['worktree', 'prune']);
    } catch {
      // 後始末の失敗は解析結果に影響しない
    }
  }
}

/** ref 時点のソースを解析してモデルを返す。モデルには解析した ref を記録する。 */
export function scanAtRef(dir: string, ref: string): Graph {
  const model = withWorktree(dir, ref, (checkout) => scan(checkout));
  model.ref = ref;
  // root は一時 worktree のパスになるため、利用者が見て意味のある元のパスに戻す
  model.root = path.resolve(dir);
  return model;
}

/** `base..head` 形式を 2 つの ref に割る。`..` が無ければ null。 */
export function splitRefRange(spec: string): { base: string; head: string } | null {
  const i = spec.indexOf('..');
  if (i < 0) return null;
  const base = spec.slice(0, i);
  const head = spec.slice(i + 2);
  return base !== '' && head !== '' ? { base, head } : null;
}
