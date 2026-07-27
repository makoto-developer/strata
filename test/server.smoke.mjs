// サーバ(src/server.ts)のセキュリティ挙動をブラックボックスで検証する統合スモークテスト。
// 実際に serve() でリスナを立て、fetch でエンドポイントを叩く。実行: npm test
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { execFileSync } from 'node:child_process';
// 実ユーザーの ~/.config/strata/projects.json を汚さないよう、登録先を一時ディレクトリへ向ける
process.env.STRATA_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-cfg-'));

const { serve } = await import('../src/server.ts');

// Node の fetch(undici)は Host ヘッダを上書きできないため、生の http リクエストで送る
const rawRequest = (port, pathName, headers) =>
  new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathName, headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });

const fail = (m) => { console.error('✖ ' + m); process.exitCode = 1; };
const ok = (m) => console.log('✓ ' + m);

// テスト用ワークスペース: 実ファイル 1 つ + プロジェクト外を指すシンボリックリンク
const ws = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-srv-'));
fs.writeFileSync(path.join(ws, 'real.go'), 'package x\n');
const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-out-'));
fs.writeFileSync(path.join(outside, 'secret.go'), 'package secret\n');
fs.symlinkSync(path.join(outside, 'secret.go'), path.join(ws, 'evil.go'));

const port = 8900 + Math.floor((process.pid % 1000));
const server = serve(ws, port);
const base = `http://127.0.0.1:${port}`;
await new Promise((r) => setTimeout(r, 300));

const get = (p, headers = {}) => fetch(base + p, { headers });

try {
  // 正常な同一オリジンのソース取得は 200
  {
    const r = await get('/source?f=real.go', { 'sec-fetch-site': 'same-origin' });
    if (r.status === 200) ok('server: 正規ファイルの /source は 200');
    else fail('正規 /source が ' + r.status);
  }
  // パストラバーサルは 403
  {
    const r = await get('/source?f=../' + path.basename(outside) + '/secret.go');
    if (r.status === 403) ok('server: パストラバーサルを 403 で拒否');
    else fail('traversal が ' + r.status);
  }
  // シンボリックリンクでのプロジェクト外読み取りは 403(realpath 封じ込め)
  {
    const r = await get('/source?f=evil.go');
    if (r.status === 403) ok('server: シンボリックリンク越しの読み取りを 403 で拒否');
    else fail('symlink escape が ' + r.status + '(封じ込め漏れ)');
  }
  // /files はシンボリックリンク先(secret.go)を列挙しない
  {
    const r = await get('/files');
    const j = await r.json();
    if (Array.isArray(j.files) && j.files.includes('real.go') && !j.files.some((f) => f.includes('secret')))
      ok('server: /files はプロジェクト外リンクを列挙しない');
    else fail('/files が想定外: ' + JSON.stringify(j.files));
  }
  // 別 Host(DNS リバインディング)は 403
  {
    const code = await rawRequest(port, '/source?f=real.go', { host: 'evil.example.com' });
    if (code === 403) ok('server: 不正 Host を 403 で拒否');
    else fail('別 Host が ' + code);
  }
  // クロスサイト fetch は 403(CSRF)
  {
    const r = await get('/files', { 'sec-fetch-site': 'cross-site' });
    if (r.status === 403) ok('server: クロスサイトリクエストを 403 で拒否');
    else fail('cross-site が ' + r.status);
  }
  // プロジェクト管理: 追加 → 編集(改名) → 存在しないパスの拒否 → 整理(prune)
  {
    const post = async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${port}${p}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: r.status, json: await r.json() };
    };
    const list = async () => (await (await fetch(`http://127.0.0.1:${port}/projects`)).json()).projects;

    const renamed = await post('/projects/update', { path: ws, name: 'リネーム後' });
    const after = await list();
    if (renamed.json.ok && after.some((p) => p.path === ws && p.name === 'リネーム後')) {
      ok('server: プロジェクトの表示名を編集できる');
    } else {
      fail(`表示名の編集が反映されない: ${JSON.stringify(renamed.json)}`);
    }

    const bad = await post('/projects/update', { path: ws, newPath: path.join(os.tmpdir(), 'strata-not-exist-xyz') });
    if (bad.json.error) ok('server: 存在しないパスへの編集を拒否する');
    else fail('存在しないパスへの編集が通ってしまった');

    // 相対パスはサーバの cwd 基準で解決されてしまい、利用者からは何が登録されるか予測できない
    const relAdd = await post('/projects', { path: 'examples' });
    const relComp = await post('/projects/composite', { name: 'x', paths: ['examples', 'test'] });
    const relEdit = await post('/projects/update', { path: ws, newPath: 'examples' });
    const rejects = [relAdd, relComp, relEdit].every(
      (r) => r.status === 400 && String(r.json.error).includes('絶対パス'),
    );
    if (rejects) ok('server: 相対パスの登録・編集を理由つきで拒否する');
    else fail(`相対パスが通ってしまった: ${JSON.stringify([relAdd.json, relComp.json, relEdit.json])}`);

    // 存在しない登録を混ぜてから prune で消えることを確認する
    const ghost = path.join(os.tmpdir(), 'strata-ghost-' + Math.random().toString(36).slice(2));
    fs.mkdirSync(ghost);
    await post('/projects', { path: ghost });
    fs.rmSync(ghost, { recursive: true, force: true });
    const pruned = await post('/projects/prune', {});
    const afterPrune = await list();
    if (pruned.json.removed >= 1 && !afterPrune.some((p) => p.path === ghost)) {
      ok('server: 見つからないパスの登録をまとめて削除できる');
    } else {
      fail(`prune が効いていない: ${JSON.stringify(pruned.json)}`);
    }
  }
  // 差分タブ: /refs で ref 一覧、/diff で 2 つの ref を worktree に取り出して比較する
  {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-git-'));
    const git = (...args) =>
      execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    try {
      git('init', '-q', '-b', 'trunk');
      git('config', 'user.email', 'test@example.invalid');
      git('config', 'user.name', 'test');
      // 実行環境の署名・注釈タグ強制の設定に左右されないようにする
      git('config', 'commit.gpgsign', 'false');
      git('config', 'tag.gpgSign', 'false');
      git('config', 'tag.forceSignAnnotated', 'false');
      fs.mkdirSync(path.join(repo, 'a'));
      fs.writeFileSync(path.join(repo, 'a', 'go.mod'), 'module a\ngo 1.22\n');
      fs.writeFileSync(path.join(repo, 'a', 'a.go'), 'package main\nfunc A(){}\n');
      git('add', '-A');
      git('commit', '-qm', 'base');
      git('tag', '-a', 'v1', '-m', 'v1');
      fs.writeFileSync(path.join(repo, 'a', 'a.go'), 'package main\nfunc A(){ B() }\nfunc B(){}\n');
      git('add', '-A');
      git('commit', '-qm', 'add B (#42)');

      const port2 = port + 1;
      const server2 = serve(repo, port2);
      await new Promise((r) => setTimeout(r, 300));
      try {
        const refs = await (await fetch(`http://127.0.0.1:${port2}/refs`)).json();
        if (refs.git === true && refs.head === 'trunk' && refs.tags.includes('v1'))
          ok('server: /refs がブランチ・タグ・HEAD を返す');
        else fail('/refs が想定外: ' + JSON.stringify(refs));

        const d = await (await fetch(`http://127.0.0.1:${port2}/diff?base=v1`)).json();
        if (d.base === 'v1' && d.head === null && d.diff.addedEdgeCount >= 1)
          ok('server: /diff が ref と作業ツリーの差分を返す(head 省略)');
        else fail('/diff(作業ツリー)が想定外: ' + JSON.stringify(d));

        const d2 = await (await fetch(`http://127.0.0.1:${port2}/diff?base=v1&head=trunk`)).json();
        if (d2.pr === 42) ok('server: /diff が head コミットから PR 番号を復元する');
        else fail('/diff の PR 検出が想定外: ' + JSON.stringify(d2));

        const bad = await fetch(`http://127.0.0.1:${port2}/diff?base=no-such-ref`);
        if (bad.status === 400) ok('server: /diff は解決できない ref を 400 で拒否');
        else fail('不正 ref が ' + bad.status);

        // ref 指定の解析は一時 worktree で行うので、元のリポジトリは汚れない
        const status = git('status', '--porcelain');
        const worktrees = git('worktree', 'list').trim().split('\n');
        if (status.trim() === '' && worktrees.length === 1)
          ok('server: /diff の後に作業ツリー・worktree が残らない');
        else fail(`後始末が不十分: status=${JSON.stringify(status)} worktrees=${worktrees.length}`);
      } finally {
        server2.close();
      }
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  }
} finally {
  server.close();
  fs.rmSync(ws, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
}

console.log(process.exitCode ? '\nサーバテスト失敗あり' : '\nサーバテスト全件成功');
