// ローカルビューアサーバー(docs/SPEC.md §8.4, §8.7)。localhost のみにバインドする。
// 複数プロジェクト(読み込むリポジトリ)を ~/.config/strata/projects.json で管理し、
// `?p=<abs path>` で切り替える。/source /files は登録済みプロジェクトのみ許可。

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { parseGraph } from './model.ts';
import type { Graph } from './model.ts';
import { SKIP_DIRS, scan } from './scan.ts';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export function webDir(): string {
  // 通常実行(node src/cli.ts)は自分の位置から ../web/。
  // 単一実行ファイル向けにバンドルすると import.meta.url が空になるため、
  // その場合は実行ファイルの隣の web/ を見る(SEA では埋め込み資産が優先される)。
  const here = typeof import.meta.url === 'string' ? import.meta.url : '';
  if (here.startsWith('file:')) return fileURLToPath(new URL('../web/', here));
  return path.join(path.dirname(process.execPath), 'web');
}

/**
 * ビューアの静的資産(index.html / app.js / style.css)を読む。
 * 単一実行ファイル(SEA)として配布したときは web/ がディスクに無いため、
 * 実行ファイルへ埋め込んだ資産から読む。開発時・git clone 実行時は web/ から読む。
 */
export function readWebAsset(name: string): Buffer | null {
  const sea = seaApi();
  if (sea) {
    try {
      return Buffer.from(sea.getRawAsset(name));
    } catch {
      return null; // 埋め込みに無い名前(パストラバーサル狙いを含む)
    }
  }
  const webRoot = path.resolve(webDir());
  const resolved = path.resolve(webRoot, name);
  // パストラバーサル防止(接尾辞 path.sep で兄弟ディレクトリの前方一致も防ぐ)
  if (resolved !== webRoot && !resolved.startsWith(webRoot + path.sep)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return fs.readFileSync(resolved);
}

/** SEA として動いている場合のみ node:sea の API を返す。 */
function seaApi(): { getRawAsset(name: string): ArrayBuffer } | null {
  try {
    // getBuiltinModule は ESM・CJS・バンドル後のいずれでも使える(require の解決に依存しない)
    const get = (process as { getBuiltinModule?: (id: string) => unknown }).getBuiltinModule;
    if (typeof get !== 'function') return null;
    const sea = get('node:sea') as { isSea(): boolean; getRawAsset(name: string): ArrayBuffer } | undefined;
    return sea && sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}

// ソース表示を許可する拡張子(それ以外は 403)。ファイルツリー(/files)の一覧対象も同じ
const SOURCE_EXTS = new Set([
  '.go', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.proto', '.ex', '.exs',
  '.md', '.json', '.jsonc', '.yaml', '.yml', '.toml', '.mod', '.sum', '.sql', '.graphql', '.sh', '.css', '.html',
]);
const SOURCE_MAX_BYTES = 2 * 1024 * 1024;
const FILE_LIST_MAX = 20000;

// ---------- git 連携(blame / コミット・PR 参照) ----------

export interface BlameLine {
  sha: string;
  line: number;
  author: string;
  time: number; // unix 秒
  summary: string;
}

/** `git blame --line-porcelain` の出力を行ごとの情報に変換する。 */
export function parseBlamePorcelain(out: string): BlameLine[] {
  const result: BlameLine[] = [];
  const meta = new Map<string, { author: string; time: number; summary: string }>();
  let curSha = '';
  let curLine = 0;
  for (const raw of out.split('\n')) {
    const header = raw.match(/^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/);
    if (header) {
      curSha = header[1];
      curLine = Number(header[2]);
      if (!meta.has(curSha)) meta.set(curSha, { author: '', time: 0, summary: '' });
      continue;
    }
    const m = meta.get(curSha);
    if (!m) continue;
    if (raw.startsWith('author ')) m.author = raw.slice(7);
    else if (raw.startsWith('author-time ')) m.time = Number(raw.slice(12));
    else if (raw.startsWith('summary ')) m.summary = raw.slice(8);
    else if (raw.startsWith('\t')) result.push({ sha: curSha, line: curLine, ...m });
  }
  return result;
}

/** コミットメッセージから PR 番号を推測する(squash / merge コミットの規約)。 */
export function detectPrNumber(subject: string, body: string): number | null {
  const squash = subject.match(/\(#(\d+)\)\s*$/);
  if (squash) return Number(squash[1]);
  const merge = subject.match(/^Merge pull request #(\d+)/);
  if (merge) return Number(merge[1]);
  const bodyRef = body.match(/^PR[-: ]#?(\d+)/m);
  return bodyRef ? Number(bodyRef[1]) : null;
}

function normalizeRepoUrl(remote: string): string | null {
  const trimmed = remote.trim().replace(/\.git$/, '');
  const ssh = trimmed.match(/^git@([^:]+):(.+)$/);
  if (ssh) return `https://${ssh[1]}/${ssh[2]}`;
  if (/^https?:\/\//.test(trimmed)) return trimmed;
  return null;
}

// ---------- プロジェクトレジストリ ----------

interface ProjectEntry {
  name: string;
  path: string; // 絶対パス(複合の場合はシンボリックリンクを束ねたワークスペースのパス)
  composite?: boolean;
  paths?: string[]; // 複合プロジェクトを構成するリポジトリの絶対パス
}

// プロジェクト登録の保存先。テストや検証で実際の設定を汚さないよう環境変数で差し替えられる
// (テストが起動する一時ディレクトリのサーバが、ユーザーの projects.json に登録されてしまっていた)
const REG_DIR = process.env.STRATA_CONFIG_DIR
  ? path.resolve(process.env.STRATA_CONFIG_DIR)
  : path.join(os.homedir(), '.config', 'strata');
const REG_FILE = path.join(REG_DIR, 'projects.json');
const WORKSPACES_DIR = path.join(REG_DIR, 'workspaces');

/**
 * 複合プロジェクト: 複数リポジトリへのシンボリックリンクを束ねたワークスペースを作る。
 * 複数案件を横断して 1 つの依存グラフとして解析するための仕組み。
 */
function createCompositeWorkspace(name: string, dirs: string[]): string {
  const safe = name.replace(/[^\w\-\u3000-\u9fff]+/g, '-').slice(0, 60) || 'workspace';
  const wsDir = path.join(WORKSPACES_DIR, safe);
  fs.rmSync(wsDir, { recursive: true, force: true });
  fs.mkdirSync(wsDir, { recursive: true });
  const used = new Set<string>();
  for (const dir of dirs) {
    let alias = path.basename(dir);
    let i = 2;
    while (used.has(alias)) alias = path.basename(dir) + '-' + i++;
    used.add(alias);
    fs.symlinkSync(dir, path.join(wsDir, alias));
  }
  return wsDir;
}

function loadRegistry(): ProjectEntry[] {
  try {
    const parsed = JSON.parse(fs.readFileSync(REG_FILE, 'utf8')) as { projects?: ProjectEntry[] };
    return Array.isArray(parsed.projects) ? parsed.projects.filter((p) => typeof p.path === 'string') : [];
  } catch {
    return [];
  }
}

function saveRegistry(list: ProjectEntry[]): void {
  fs.mkdirSync(REG_DIR, { recursive: true });
  fs.writeFileSync(REG_FILE, JSON.stringify({ projects: list }, null, 2) + '\n');
}

function projectName(abs: string): string {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(abs, 'strata.config.json'), 'utf8')) as { name?: string };
    if (typeof conf.name === 'string' && conf.name !== '') return conf.name;
  } catch {
    // 設定がなければディレクトリ名
  }
  return path.basename(abs);
}

function registerProject(abs: string): void {
  const list = loadRegistry();
  if (list.some((p) => path.resolve(p.path) === abs)) return;
  list.push({ name: projectName(abs), path: abs });
  saveRegistry(list);
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c: Buffer) => {
      data += c.toString();
      if (data.length > 1024 * 64) req.destroy();
    });
    req.on('end', () => {
      try {
        const parsed = JSON.parse(data || '{}');
        resolve(parsed && typeof parsed === 'object' ? parsed : {});
      } catch {
        resolve({});
      }
    });
  });
}

// ---------- サーバー ----------

export function serve(defaultInput: string, port: number, opts: { watch?: boolean } = {}): http.Server {
  const dir = webDir();
  const defaultAbs = path.resolve(defaultInput);
  const defaultIsDir = fs.existsSync(defaultAbs) && fs.statSync(defaultAbs).isDirectory();
  if (defaultIsDir) registerProject(defaultAbs);
  let cachedDefaultRoot: string | null = null; // 既定入力が model.json のときの root キャッシュ

  // watch モード: ファイル変更を検知してブラウザを自動リロード(Server-Sent Events)
  const sseClients = new Set<http.ServerResponse>();
  const broadcastReload = (): void => {
    for (const client of [...sseClients]) {
      try {
        client.write('event: reload\ndata: 1\n\n');
      } catch {
        sseClients.delete(client);
      }
    }
  };
  if (opts.watch && defaultIsDir) {
    let timer: NodeJS.Timeout | null = null;
    try {
      fs.watch(defaultAbs, { recursive: true }, (_evt, filename) => {
        // SKIP_DIRS(.git / node_modules / vendor 等)の変更は無視
        if (filename && String(filename).split(/[\\/]/).some((p) => SKIP_DIRS.has(p))) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(broadcastReload, 200);
      });
      console.log('👁  watch モード: ファイル変更でブラウザを自動リロードします');
    } catch (err) {
      console.error('watch を有効化できませんでした: ' + (err as Error).message);
    }
  }

  const modelFor = (input: string): Graph => {
    if (input.endsWith('.json') && fs.existsSync(input) && fs.statSync(input).isFile()) {
      return parseGraph(fs.readFileSync(input, 'utf8'), input);
    }
    return scan(input);
  };

  /** `?p=` を解決する。登録済みプロジェクト以外は拒否(403 の代わりに null)。 */
  const resolveProject = (p: string | null): string | null => {
    if (p === null || p === '') return defaultIsDir ? defaultAbs : defaultInput;
    const abs = path.resolve(p);
    if (abs === defaultAbs) return abs;
    const ok = loadRegistry().some((entry) => path.resolve(entry.path) === abs);
    return ok ? abs : null;
  };

  /** /source /files 用のワークスペースルート。 */
  const rootFor = (p: string | null): string | null => {
    const input = resolveProject(p);
    if (input === null) return null;
    if (fs.existsSync(input) && fs.statSync(input).isDirectory()) return path.resolve(input);
    cachedDefaultRoot ??= modelFor(input).root;
    return path.resolve(cachedDefaultRoot);
  };

  // 読み取りを許可する「実パスの root 集合」。通常プロジェクトは root 自身の実パス。
  // 複合プロジェクトはワークスペースがシンボリックリンク束なので、登録された各 paths[] の
  // 実パスも許可する(実ファイルは各リポジトリ配下に解決される)。
  const allowedRealRootsFor = (p: string | null, root: string): string[] => {
    const roots = new Set<string>();
    const push = (d: string): void => {
      try {
        roots.add(fs.realpathSync(d));
      } catch {
        /* 存在しないリンク先などは無視 */
      }
    };
    const abs = resolveProject(p);
    if (abs !== null) {
      const entry = loadRegistry().find((e) => path.resolve(e.path) === abs);
      if (entry?.composite && Array.isArray(entry.paths)) for (const d of entry.paths) push(d);
    }
    push(root);
    return [...roots];
  };

  // resolved(root 相対から path.resolve したパス)をシンボリックリンク解決後の実パスで
  // root 集合に封じ込める。含まれていれば実パスを返し、外れていれば null(= 403 相当)。
  // これにより許可拡張子名のシンボリックリンクでプロジェクト外へ抜ける攻撃を防ぐ。
  const containedReal = (resolved: string, allowedRoots: string[]): string | null => {
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      return null;
    }
    for (const r of allowedRoots) if (real === r || real.startsWith(r + path.sep)) return real;
    return null;
  };

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url ?? '/', 'http://localhost');
    const url = u.pathname;
    const pParam = u.searchParams.get('p');
    const sendJson = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const sendText = (status: number, text: string): void => {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(text);
    };
    // DNS リバインディング対策: Host は localhost / 127.0.0.1 / [::1] のみ許可。
    // サーバは 127.0.0.1 バインドだが、被害者ブラウザ経由で攻撃ドメインを 127.0.0.1 に
    // 再バインドされても、Host ヘッダは元のホスト名のままなのでここで弾ける。
    // (CLI 等 Host 無しのリクエストは許可)
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    const allowedHosts = new Set([
      `localhost:${port}`,
      `127.0.0.1:${port}`,
      `[::1]:${port}`,
      'localhost',
      '127.0.0.1',
      '[::1]',
    ]);
    if (hostHeader !== '' && !allowedHosts.has(hostHeader)) return sendText(403, 'forbidden host');
    // CSRF 対策: ブラウザからのクロスサイトリクエスト(Sec-Fetch-Site: cross-site / same-site)を拒否。
    // 通常のページ遷移(none)・アプリ内 fetch(same-origin)は許可。非ブラウザ(ヘッダ無し)も許可。
    const fetchSite = (req.headers['sec-fetch-site'] as string | undefined)?.toLowerCase();
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      return sendText(403, 'cross-site request blocked');
    }
    try {
      if (url === '/events') {
        // watch モードのライブリロード用 SSE。watch 無効でも接続は受ける(何も送らないだけ)
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write('retry: 3000\n\n');
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      if (url === '/model.json') {
        const input = resolveProject(pParam);
        if (input === null) return sendText(403, 'unknown project');
        return sendJson(200, modelFor(input));
      }
      if (url === '/projects' && req.method === 'GET') {
        const projects = loadRegistry().map((entry) => ({
          name: entry.name,
          path: entry.path,
          composite: entry.composite === true,
          paths: entry.paths,
          exists: fs.existsSync(entry.path) && fs.statSync(entry.path).isDirectory(),
        }));
        return sendJson(200, { default: defaultIsDir ? defaultAbs : null, projects });
      }
      if (url === '/projects' && req.method === 'POST') {
        const body = await readBody(req);
        const raw = typeof body.path === 'string' ? body.path.trim() : '';
        const abs = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw);
        if (raw === '' || !fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          return sendJson(400, { error: 'ディレクトリが見つかりません: ' + raw });
        }
        registerProject(abs);
        return sendJson(200, { ok: true, path: abs });
      }
      if (url === '/projects/composite' && req.method === 'POST') {
        const body = await readBody(req);
        const name = typeof body.name === 'string' ? body.name.trim() : '';
        const rawPaths = Array.isArray(body.paths) ? body.paths : [];
        const dirs: string[] = [];
        for (const raw of rawPaths) {
          if (typeof raw !== 'string' || raw.trim() === '') continue;
          const trimmed = raw.trim();
          const abs = trimmed.startsWith('~/') ? path.join(os.homedir(), trimmed.slice(2)) : path.resolve(trimmed);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            return sendJson(400, { error: 'ディレクトリが見つかりません: ' + trimmed });
          }
          dirs.push(abs);
        }
        if (name === '' || dirs.length < 2) {
          return sendJson(400, { error: '名前と 2 つ以上のディレクトリを指定してください' });
        }
        const wsDir = createCompositeWorkspace(name, dirs);
        const list = loadRegistry().filter((entry) => path.resolve(entry.path) !== wsDir);
        list.push({ name, path: wsDir, composite: true, paths: dirs });
        saveRegistry(list);
        return sendJson(200, { ok: true, path: wsDir });
      }
      if (url === '/projects/update' && req.method === 'POST') {
        // 登録済みプロジェクトの表示名・パスを編集する(ディレクトリ自体は動かさない)
        const body = await readBody(req);
        const target = typeof body.path === 'string' ? path.resolve(body.path) : '';
        const list = loadRegistry();
        const entry = list.find((e) => path.resolve(e.path) === target);
        if (!entry) return sendJson(404, { error: '登録されていないプロジェクトです' });
        if (typeof body.name === 'string' && body.name.trim() !== '') entry.name = body.name.trim();
        if (typeof body.newPath === 'string' && body.newPath.trim() !== '') {
          if (entry.composite) {
            return sendJson(400, { error: '複合プロジェクトのパスは編集できません(作り直してください)' });
          }
          const raw = body.newPath.trim();
          const abs = raw.startsWith('~/') ? path.join(os.homedir(), raw.slice(2)) : path.resolve(raw);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
            return sendJson(400, { error: 'ディレクトリが見つかりません: ' + raw });
          }
          if (list.some((e) => e !== entry && path.resolve(e.path) === abs)) {
            return sendJson(400, { error: 'そのパスは既に登録されています' });
          }
          entry.path = abs;
        }
        saveRegistry(list);
        return sendJson(200, { ok: true, path: entry.path, name: entry.name });
      }
      if (url === '/projects/prune' && req.method === 'POST') {
        // 存在しないディレクトリの登録をまとめて削除する(一時ディレクトリの残骸対策)
        const list = loadRegistry();
        const alive = list.filter((e) => fs.existsSync(e.path) && fs.statSync(e.path).isDirectory());
        saveRegistry(alive);
        return sendJson(200, { ok: true, removed: list.length - alive.length });
      }
      if (url === '/projects/delete' && req.method === 'POST') {
        const body = await readBody(req);
        const raw = typeof body.path === 'string' ? body.path : '';
        const abs = path.resolve(raw);
        const entry = loadRegistry().find((e) => path.resolve(e.path) === abs);
        saveRegistry(loadRegistry().filter((e) => path.resolve(e.path) !== abs));
        // 複合プロジェクトはシンボリックリンク置き場も片付ける(実リポジトリには触れない)
        if (entry?.composite && abs.startsWith(path.resolve(WORKSPACES_DIR) + path.sep)) {
          fs.rmSync(abs, { recursive: true, force: true });
        }
        return sendJson(200, { ok: true });
      }
      if (url === '/files') {
        const root = rootFor(pParam);
        if (root === null) return sendText(403, 'unknown project');
        const allowedRoots = allowedRealRootsFor(pParam, root);
        const files: string[] = [];
        const visit = (dirAbs: string, rel: string): void => {
          if (files.length >= FILE_LIST_MAX) return;
          let entries: fs.Dirent[];
          try {
            entries = fs.readdirSync(dirAbs, { withFileTypes: true });
          } catch {
            return;
          }
          for (const e of entries) {
            const childRel = rel === '' ? e.name : rel + '/' + e.name;
            let isDir = e.isDirectory();
            if (!isDir && rel === '' && e.isSymbolicLink()) {
              // トップレベルのシンボリックリンクは複合プロジェクトのリポジトリ束のみ辿る。
              // link -> / のようなリンクでファイルシステム全体を列挙されるのを防ぐ。
              if (containedReal(path.join(dirAbs, e.name), allowedRoots) === null) continue;
              try {
                isDir = fs.statSync(path.join(dirAbs, e.name)).isDirectory();
              } catch {
                continue;
              }
            }
            if (isDir) {
              if (!SKIP_DIRS.has(e.name)) visit(path.join(dirAbs, e.name), childRel);
            } else if (e.isFile() && SOURCE_EXTS.has(path.extname(e.name))) {
              files.push(childRel);
            }
          }
        };
        visit(root, '');
        files.sort();
        return sendJson(200, { files });
      }
      if (url === '/open') {
        // ローカルのエディタでファイルを開く(vscode:// が使えないブラウザ向け)。
        // STRATA_EDITOR="code -g {file}:{line}" のようにコマンドを差し替え可能
        const root = rootFor(pParam);
        if (root === null) return sendText(403, 'unknown project');
        const rel = u.searchParams.get('f') ?? '';
        const line = u.searchParams.get('l') ?? '';
        const resolved = path.resolve(root, rel);
        if (!resolved.startsWith(root + path.sep) || !SOURCE_EXTS.has(path.extname(resolved))) {
          return sendText(403, 'forbidden');
        }
        // シンボリックリンク解決後の実パスで root 封じ込めを再検査(リンク経由の逸脱防止)
        const real = containedReal(resolved, allowedRealRootsFor(pParam, root));
        if (real === null) return sendText(403, 'forbidden');
        if (!fs.existsSync(real)) return sendText(404, 'not found');
        const lineNum = /^\d+$/.test(line) ? Number(line) : 1;
        try {
          const custom = process.env.STRATA_EDITOR;
          if (custom) {
            const parts = custom
              .split(/\s+/)
              // 置換値にファイルパスが入るため関数形式にする($& などの展開を防ぐ)
              .map((part) => part.replace('{file}', () => real).replace('{line}', () => String(lineNum)));
            await execFileAsync(parts[0], parts.slice(1));
          } else {
            try {
              await execFileAsync('code', ['-g', `${real}:${lineNum}`]);
            } catch {
              await execFileAsync('open', [real]); // フォールバック: 既定アプリで開く
            }
          }
          return sendJson(200, { ok: true });
        } catch (err) {
          return sendJson(500, { error: (err as Error).message.split('\n')[0] });
        }
      }
      if (url === '/blame') {
        const root = rootFor(pParam);
        if (root === null) return sendText(403, 'unknown project');
        const rel = u.searchParams.get('f') ?? '';
        const resolved = path.resolve(root, rel);
        if (!resolved.startsWith(root + path.sep) || !SOURCE_EXTS.has(path.extname(resolved))) {
          return sendText(403, 'forbidden');
        }
        // 実パスで root 封じ込め(複合プロジェクトは登録済みリポジトリのみ)
        const real = containedReal(resolved, allowedRealRootsFor(pParam, root));
        if (real === null) return sendText(403, 'forbidden');
        try {
          const { stdout } = await execFileAsync(
            'git',
            ['-C', path.dirname(real), 'blame', '--line-porcelain', '--', real],
            { maxBuffer: 16 * 1024 * 1024 },
          );
          return sendJson(200, { lines: parseBlamePorcelain(stdout) });
        } catch (err) {
          return sendJson(404, { error: 'git blame を実行できません(未コミットのファイル?): ' + (err as Error).message.split('\n')[0] });
        }
      }
      if (url === '/commit') {
        const root = rootFor(pParam);
        if (root === null) return sendText(403, 'unknown project');
        const sha = u.searchParams.get('sha') ?? '';
        const rel = u.searchParams.get('f') ?? '';
        if (!/^[0-9a-f]{7,40}$/.test(sha)) return sendText(400, 'invalid sha');
        // rel を root 外に向けて任意リポジトリの履歴を引く攻撃を防ぐため、実パスで封じ込め
        let base = root;
        if (rel !== '') {
          const realFile = containedReal(path.resolve(root, rel), allowedRealRootsFor(pParam, root));
          if (realFile === null) return sendText(403, 'forbidden');
          base = path.dirname(realFile);
        }
        try {
          const { stdout: metaOut } = await execFileAsync(
            'git',
            ['-C', base, 'show', '-s', '--format=%H%x1f%an%x1f%at%x1f%s%x1f%b', sha],
            { maxBuffer: 1024 * 1024 },
          );
          const [fullSha, author, timeStr, subject, body = ''] = metaOut.split('\x1f');
          const { stdout: patch } = await execFileAsync(
            'git',
            ['-C', base, 'show', '--no-color', '--stat', '--patch', sha],
            { maxBuffer: 16 * 1024 * 1024 },
          );
          let repoUrl: string | null = null;
          try {
            const { stdout: remote } = await execFileAsync('git', ['-C', base, 'remote', 'get-url', 'origin']);
            repoUrl = normalizeRepoUrl(remote);
          } catch {
            // リモートなしでも続行
          }
          return sendJson(200, {
            sha: fullSha.trim(),
            author,
            time: Number(timeStr),
            subject,
            pr: detectPrNumber(subject, body),
            repoUrl,
            patch: patch.length > 400_000 ? patch.slice(0, 400_000) + '\n…(以下省略)' : patch,
          });
        } catch (err) {
          return sendJson(404, { error: 'コミットを取得できません: ' + (err as Error).message.split('\n')[0] });
        }
      }
      if (url === '/source') {
        const root = rootFor(pParam);
        if (root === null) return sendText(403, 'unknown project');
        const rel = u.searchParams.get('f') ?? '';
        const resolved = path.resolve(root, rel);
        const ext = path.extname(resolved);
        if (!resolved.startsWith(root + path.sep) || !SOURCE_EXTS.has(ext)) return sendText(403, 'forbidden');
        // シンボリックリンク解決後の実パスで root 封じ込め(許可拡張子名のリンクによる逸脱防止)
        const real = containedReal(resolved, allowedRealRootsFor(pParam, root));
        if (real === null) return sendText(403, 'forbidden');
        if (!fs.statSync(real).isFile()) return sendText(404, 'not found');
        if (fs.statSync(real).size > SOURCE_MAX_BYTES) return sendText(413, 'file too large');
        return sendJson(200, { path: rel, content: fs.readFileSync(real, 'utf8') });
      }
      const file = url === '/' ? 'index.html' : url.slice(1);
      const body = readWebAsset(file);
      if (body === null) return sendText(404, 'not found');
      const ext = path.extname(file);
      res.writeHead(200, { 'content-type': MIME[ext] ?? 'application/octet-stream', 'cache-control': 'no-store' });
      res.end(body);
    } catch (err) {
      sendText(500, String(err));
    }
  });
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      console.error(
        `ポート ${port} は既に使用中です。--port で別のポートを指定してください` +
          `(例: strata serve . --port ${port + 1})。`,
      );
    } else if (err.code === 'EACCES') {
      console.error(`ポート ${port} を開けません(権限不足)。1024 以上のポートを指定してください。`);
    } else {
      console.error(`サーバの起動に失敗しました: ${err.message}`);
    }
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Strata ビューア: http://localhost:${port}/ (Ctrl+C で終了、リロードで再解析)`);
  });
  return server;
}
