// 解析器間で共有する型・コンテキスト・ユーティリティ(docs/SPEC.md §5.1/§7)。
//
// scan.ts(オーケストレータ)と各 analyzers が双方向に依存する循環を避けるため、
// 両者が必要とする共有物はここに置く。依存は model.ts / path-glob.ts のみ(下向き)。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { matchesAnyGlob } from './path-glob.ts';
import type { Builder, ForbiddenRule, Thresholds, UnresolvedRef } from './model.ts';

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
  // 間接層(生成クライアントライブラリ / Gateway / Federation 経由の呼び出し)の解決。既定は無効
  indirection?: IndirectionConf;
  // IaC(k8s / Helm / Terraform)から環境変数の値を逆引きする。既定は無効
  infra?: InfraConf;
}

/** 生成物 → 元 proto の逆引き方法。どれも失敗しうるので、失敗時は例外ではなく未解決として次へ進む。 */
export type ResolveVia = 'packageComment' | 'namingConvention' | 'manifest';

/**
 * 自動検出で解決できなかったときの逃げ道。
 * 生成物の置き場所・命名がツール側の想定から外れているリポジトリだけが必要とする。
 */
export interface IndirectionPattern {
  name: string;
  importPathPattern: string; // グロブ(例 "**/gen/proto/**")
  resolveVia: ResolveVia;
  namingConvention?: { importPathToService: string }; // {package} / {service} / {version} を含むテンプレート
  manifest?: { path: string }; // 生成物 → proto の対応表(ws 相対の JSON)
  comment?: string;
}

export interface IndirectionConf {
  enabled?: boolean;
  // 未指定でも動く(生成スタブの署名とシンボル一致で自動解決する)。
  // patterns は自動検出が外れた構成のための追加ヒント
  patterns?: IndirectionPattern[];
  // 生成物として追加で読むファイル(グロブ)。ジェネレータが独自のファイル名を出す構成や、
  // 生成クライアントが依存パッケージ(node_modules 等)にしか無い構成で使う
  artifactPaths?: string[];
}

export interface InfraSource {
  type: 'kubernetes' | 'helm' | 'terraform';
  path: string; // グロブ(例 "k8s/**/*.yaml")
}

export interface InfraConf {
  enabled?: boolean;
  sources?: InfraSource[];
}

/**
 * フェーズ A(収集)が出す「まだ接続していない呼び出しの証拠」。
 * import パスではなくシンボル(service 名 + メソッド名)を証拠にするので、
 * proto と呼び出し元の間に何段の中間層があっても、構成を知らずに収集できる。
 */
export interface RpcCallEvidence {
  from: string; // 呼び出し元ノード id(Go パッケージ / JS ファイル / モジュール)
  funcId?: string; // 分かる場合の呼び出し元関数ノード id
  service: string; // 例 "UserService"
  method: string; // 例 "GetUser"
  importPaths?: string[]; // 呼び出し元ファイルの import 一覧(候補の絞り込みにだけ使う補助情報)
  // 生成クライアントのコンストラクタ(New<X>Client / <X>Stub / createClient)で掴んだか。
  // 型注釈だけの束縛は手書き interface やモックと区別できないので、短名での接続には使わない
  fromConstructor: boolean;
  // 型注釈の修飾子(`orderv1.OrderServiceClient` の `orderv1`)が指す import パス。
  // これが proto に解決できるなら、型注釈だけでも「その proto のクライアント」という強い証拠になる
  qualifierPath?: string;
  file: string; // ws 相対
  line: number;
}

/** トピック名が静的に確定しない publish / subscribe(環境変数経由 or 実行時組み立て)。 */
export interface PendingTopic {
  from: string; // 発行 / 購読しているサービスノード id
  role: 'publish' | 'subscribe';
  envVar?: string; // os.Getenv("X") 経由のとき
  expr?: string; // 実行時に組み立てているとき(静的には解決不能。表示用)
  file: string;
  line: number;
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
  goImplTypeServices: Map<string, Set<string>>; // "pkgId#Type" -> その型が実装する service 名(複数埋め込みもある)
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
  // 間接層。フェーズ A で集め、フェーズ B(src/indirection.ts)で解決する
  rpcCalls: RpcCallEvidence[];
  pendingTopics: PendingTopic[];
  unresolved: UnresolvedRef[];
}

/** 未解決参照を重複なく積む(同じ reason × from × detail は 1 件にまとめる)。 */
export function addUnresolved(ctx: Ctx, ref: UnresolvedRef): void {
  const key = ref.reason + ' ' + ref.from + ' ' + ref.detail;
  if (ctx.unresolved.some((u) => u.reason + ' ' + u.from + ' ' + u.detail === key)) return;
  ctx.unresolved.push(ref);
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

/**
 * rel が config.exclude に該当するか。走査する側すべてがこれを使う
 * (実装が分かれていると、除外したはずの場所から生成物だけ拾われる)。
 */
export function isExcluded(rel: string, config: Config, isDir = false): boolean {
  for (const pattern of config.exclude ?? []) {
    if (pattern.includes('*')) {
      if (matchesAnyGlob(rel, [pattern])) return true;
      // "**/x/**" は x 配下のファイルにしか当たらないので、枝ごと切るために x 自身とも照合する
      const trimmed = isDir ? pattern.replace(/\/\*\*?$/, '') : pattern;
      if (trimmed !== pattern && matchesAnyGlob(rel, [trimmed])) return true;
    } else if (pattern.includes('/')) {
      if (rel === pattern || rel.startsWith(pattern + '/')) return true;
    } else if (rel.split('/').includes(pattern)) {
      return true;
    }
  }
  return false;
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
