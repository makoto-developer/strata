// 公開用の画像・録画を撮る前に、対象が同梱デモであることを実際に確かめる。
//
// 各スクリプトは URL を引数で受け取る。手元の常用サーバを指したまま撮ると、
// 実在のサービス名・パス・登録済みプロジェクトが公開画像に入る。
// 「デモに固定している」とコメントで書いてあっても、検証していなければ効かない。

/** 対象が examples/demo でなければ中断する。撮影スクリプトの冒頭で必ず呼ぶ。 */
export async function assertDemoWorkspace(url) {
  const base = url.endsWith('/') ? url : url + '/';
  let model;
  try {
    const res = await fetch(base + 'model.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    model = await res.json();
  } catch (e) {
    console.error(`撮影中止: ${base}model.json を読めません (${e.message})`);
    process.exit(1);
  }
  const root = String(model.root ?? '');
  if (!/(^|\/)examples\/demo\/?$/.test(root)) {
    console.error(
      `撮影中止: 対象が同梱デモではありません\n` +
        `  解析対象: ${root}\n` +
        `  公開画像には実環境のサービス名やパスが写り込みます。\n` +
        `  STRATA_CONFIG_DIR=$(mktemp -d) node src/cli.ts serve examples/demo --port <port>\n` +
        `  で起動し直してください`,
    );
    process.exit(1);
  }
  // 登録済みの別プロジェクトはプロジェクトタブに実パスごと表示される
  try {
    const res = await fetch(base + 'projects');
    if (res.ok) {
      const list = await res.json();
      const others = (Array.isArray(list) ? list : (list.projects ?? [])).filter(
        (p) => !/(^|\/)examples\/demo\/?$/.test(String(p.path ?? '')),
      );
      if (others.length > 0) {
        console.error(
          `撮影中止: デモ以外のプロジェクトが ${others.length} 件登録されています\n` +
            others.map((p) => `  - ${p.name ?? '?'}: ${p.path ?? '?'}`).join('\n') +
            `\n  STRATA_CONFIG_DIR=$(mktemp -d) を付けて起動し直してください`,
        );
        process.exit(1);
      }
    }
  } catch {
    // projects エンドポイントが無い版でも、root の確認は済んでいる
  }
}
