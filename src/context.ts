// 解析器間で共有する型・コンテキスト・ユーティリティ(docs/SPEC.md §5.1/§7)。
//
// scan.ts(オーケストレータ)と各 analyzers が双方向に依存する循環を避けるため、
// 両者が必要とする共有物はここに置く。依存は model.ts のみ(下向き)。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Builder, ForbiddenRule, Thresholds } from './model.ts';

export interface ServiceConf {
  name: string;
  path: string;
}

export interface Config {
  name?: string;
  services?: ServiceConf[];
  exclude?: string[];
  includeTests?: boolean;
  testPaths?: string[]; // テスト扱いにする追加パス(前方一致 or ディレクトリ名)
  forbidden?: ForbiddenRule[]; // 禁止依存ルール(アーキテクチャ検査)
  thresholds?: Thresholds; // 結合度・循環の数値しきい値(check で超過を fail)
  // 非同期(Pub/Sub)検出: 発行/購読メソッド名を指定すると X.method("topic") を拾う
  messaging?: { publish?: string[]; subscribe?: string[] };
  // HTTP(REST / webhook)検出。既定は有効
  http?: {
    enabled?: boolean;
    externalHosts?: boolean; // 未解決の絶対 URL を「外部システム」ノードにする(既定 true)
    webhookPatterns?: string[]; // webhook 扱いにするパスの追加パターン(部分一致)
  };
  // GraphQL 検出。既定は有効
  graphql?: { enabled?: boolean };
}

export interface Project {
  rootRel: string; // '' = ワークスペース直下の擬似プロジェクト
  nodeId: string; // 擬似プロジェクトは ''(ノードなし)
  name: string;
  hasGo: boolean;
  hasJs: boolean;
  hasEx: boolean;
  hasPy: boolean;
  goFiles: string[]; // ワークスペース相対
  jsFiles: string[];
  exFiles: string[];
  pyFiles: string[];
  gqlFiles: string[]; // .graphql / .gql / .graphqls(スキーマ)
  protoFiles: string[];
  genGrpcFiles: string[]; // 生成済み *_grpc.pb.go(.proto ソースがない場合のフォールバック用)
  testFiles: string[]; // 除外されたテスト(RPC のテスト呼び出し検出にだけ使う)
}

export interface RpcInfo {
  rpcId: string;
  protoId: string;
  service: string;
  name: string;
}

/** 解析器間で共有するコンテキスト。 */
export interface Ctx {
  rootAbs: string;
  builder: Builder;
  config: Config;
  projects: Project[];
  // Go
  goPkgOfImportPath: Map<string, string>;
  goFuncsOfPkg: Map<string, Map<string, string>>;
  goMethodsOfPkg: Map<string, Map<string, string | null>>; // null = 同名メソッドが複数(曖昧)
  goPkgRelIndex: Map<string, Array<{ pkgId: string; project: string }>>; // モジュール相対パス → パッケージ
  goModulePrefixes: Set<string>; // 例 "github.com/makoto-developer"(内部っぽい未解決 import の警告用)
  goPkgImplServices: Map<string, Set<string>>; // pkgId -> Unimplemented<Service>Server を埋め込む service 名
  // proto
  protoGoPackage: Map<string, string>; // go_package -> proto node id
  protoGoPackageSuffix: Map<string, string | null>; // protoパッケージ名由来のパスサフィックス -> proto node id(null = 曖昧)
  protoServiceNames: Set<string>; // 実 proto に登場した service 名(生成コードとの重複防止)
  rpcByName: Map<string, RpcInfo[]>; // RPC名(原形と lowerCamel)-> 候補
  rpcByNameLower: Map<string, RpcInfo[]>; // RPC名の小文字化 -> 候補(頭字語の表記ゆれ救済用)
  rpcOfProto: Map<string, Map<string, RpcInfo>>; // proto node id -> (RPC名 -> info)
  protoFiles: Array<{ id: string; wsRel: string }>;
  protoByBase: Map<string, string[]>; // 拡張子なし基底名 -> proto node ids
  // JS/TS
  jsFileIds: Set<string>;
  jsPackageByName: Map<string, string>;
  jsExports: Map<string, Map<string, string>>; // file id -> (エクスポート名 -> func node id)
  jsProtoRefsOfProject: Map<string, Set<string>>; // project node id -> 参照 proto node ids
  jsProtoRefsOfFile: Map<string, Set<string>>; // file id -> 参照 proto node ids
}

export const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'vendor', 'dist', 'build', 'out', '.next', '.nuxt',
  'coverage', '.cache', '.idea', '.vscode', '.turbo', 'target', '__pycache__',
  'testdata', 'gen', 'generated', '__generated__', 'tmp', '.claude',
  '_build', 'deps', // Elixir/mix
]);

/** rel(サービスのルート相対など)に最も深く一致するサービス設定を返す。 */
function serviceFor(rel: string, config: Config): ServiceConf | undefined {
  let best: ServiceConf | undefined;
  for (const svc of config.services ?? []) {
    const p = svc.path.replace(/\/+$/, '');
    if (rel === p || rel.startsWith(p + '/')) {
      if (!best || p.length > best.path.length) best = svc;
    }
  }
  return best;
}

export function svcNodeId(svc: ServiceConf): string {
  return 'svc:' + svc.name;
}

/**
 * ファイルの属するディレクトリ連鎖の基点を返す。
 * プロジェクトに属さないファイル(共有 proto/ など)はサービス設定があればその配下に、
 * なければワークスペース直下にぶら下げる。
 */
export function chainBase(ctx: Ctx, project: Project, fileDir: string): { baseWsRel: string; baseId: string } {
  if (project.nodeId !== '') return { baseWsRel: project.rootRel, baseId: project.nodeId };
  const svc = serviceFor(fileDir, ctx.config);
  if (svc) {
    const svcPath = svc.path.replace(/\/+$/, '');
    if (fileDir === svcPath || fileDir.startsWith(svcPath + '/')) {
      // サービスパスのディレクトリノードをサービス配下に作る
      const dirNode = ctx.builder.addNode({
        id: svcPath,
        label: path.posix.basename(svcPath),
        parent: svcNodeId(svc),
        kind: 'dir',
      });
      return { baseWsRel: svcPath, baseId: dirNode.id };
    }
  }
  return { baseWsRel: '', baseId: '' };
}

export function readFileText(ctx: Ctx, wsRel: string): string {
  return fs.readFileSync(path.join(ctx.rootAbs, wsRel), 'utf8');
}

/** rel が config のサービスに属するか等の判定に使う内部ヘルパを scan.ts へ公開。 */
export { serviceFor };
