// 設定サーフェス検出(docs/SPEC.md §6.9)。
// 各サービスが読み取る環境変数を検出し、サービスノードの meta.envVars に載せる。
// 「このサービスは何を設定として要求するか」を可視化する(運用・オンボーディング用)。

import { readFileText, type Ctx, type Project } from '../context.ts';

// 環境変数の読み取りパターン(Go / JS・TS / Elixir / 一般的な getEnv ヘルパ)
const ENV_RES: RegExp[] = [
  /\b(?:os\.)?Getenv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, // Go: os.Getenv("X")
  /\b(?:os\.)?LookupEnv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, // Go: os.LookupEnv("X")
  /\bgetEnv\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, // 自作ヘルパ getEnv("X", ...)
  /\bprocess\.env\.([A-Za-z_][A-Za-z0-9_]*)/g, // JS: process.env.X
  /\bprocess\.env\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/g, // JS: process.env["X"]
  /\bSystem\.(?:get_env|fetch_env!?)\(\s*"([A-Za-z_][A-Za-z0-9_]*)"/g, // Elixir: System.get_env("X")
  /\bos\.getenv\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g, // Python: os.getenv("X")
  /\bos\.environ\.get\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]/g, // Python: os.environ.get("X")
  /\bos\.environ\[\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\]/g, // Python: os.environ["X"]
];

function extractEnvVars(src: string): string[] {
  const out = new Set<string>();
  for (const re of ENV_RES) {
    re.lastIndex = 0;
    for (let m = re.exec(src); m; m = re.exec(src)) out.add(m[1]);
  }
  return [...out];
}

/** ノードの最上位祖先(サービス/モジュールの根)。 */
function topAncestorId(ctx: Ctx, id: string): string {
  let cur = id;
  for (let guard = 0; guard < 200; guard++) {
    const node = ctx.builder.get(cur);
    if (!node || !node.parent) return cur;
    cur = node.parent;
  }
  return cur;
}

export function detectConfigSurface(ctx: Ctx): void {
  for (const project of ctx.projects) {
    const anchor = project.nodeId !== '' ? project.nodeId : '';
    const target = anchor === '' ? '' : topAncestorId(ctx, anchor);
    if (target === '') continue; // 擬似プロジェクト(ワークスペース直下)は対象外
    const vars = new Set<string>();
    const files: string[] = [...project.goFiles, ...project.jsFiles, ...project.exFiles, ...project.pyFiles];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileText(ctx, rel);
      } catch {
        continue;
      }
      for (const v of extractEnvVars(src)) vars.add(v);
    }
    if (vars.size === 0) continue;
    const node = ctx.builder.get(target);
    if (node) node.meta = { ...node.meta, envVars: [...vars].sort() };
  }
}

// テスト用に個別関数も公開
export { extractEnvVars };
