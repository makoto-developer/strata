// ワークスペース走査・プロジェクト検出・設定読込・解析のオーケストレーション(docs/SPEC.md §5.1)

import * as fs from 'node:fs';
import * as path from 'node:path';
import { Builder, type Coverage, type Graph } from './model.ts';
import { stripSource } from './lex.ts';
import { SKIP_DIRS, svcNodeId, serviceFor, isExcluded } from './context.ts';
import type { ServiceConf, Config, Project, RpcInfo, Ctx } from './context.ts';
// 後方互換: 共有物は context.ts へ移したが、従来 scan.ts から import していた
// コード(server.ts など)向けに再公開する。
export { SKIP_DIRS, svcNodeId, chainBase, readFileText } from './context.ts';
export type { ServiceConf, Config, Project, RpcInfo, Ctx } from './context.ts';
import { registerProto, registerGeneratedStubs, linkProto } from './analyzers/proto.ts';
import { registerGo, linkGo } from './analyzers/golang.ts';
import { registerJs, linkJs } from './analyzers/jsts.ts';
import { registerEx, linkEx } from './analyzers/elixir.ts';
import { registerPy, linkPy } from './analyzers/python.ts';
import { linkTests } from './analyzers/tests.ts';
import { detectConfigSurface } from './analyzers/config.ts';
import { detectMessaging } from './analyzers/messaging.ts';
import { resolveInfraTopics } from './analyzers/infra.ts';
import { detectHttp } from './analyzers/http.ts';
import { detectGraphql } from './analyzers/graphql.ts';
import { registerOpenapi, linkOpenapi } from './analyzers/openapi.ts';
import { registerDeploy } from './analyzers/deploy.ts';
import { classifyDataFile } from './datafile.ts';
import { collectRpcCallEvidence } from './rpc-call-evidence.ts';
import { resolveIndirection } from './indirection.ts';
import { markViolations } from './rules.ts';
import { importMatchesDir } from './indirection.ts';

/**
 * 言語アナライザの登録(register)→接続(link)の 2 相を表す。
 * 対応言語を増やすときは register/link を実装し、下の ANALYZERS に 1 エントリ足すだけ。
 * afterRegisterAll は「そのアナライザの全プロジェクト登録後」に挟む後処理
 * (proto の生成スタブ復元のように、全 proto 登録後に走らせたい処理)用。
 */
interface LanguageAnalyzer<S> {
  name: string;
  register(ctx: Ctx, project: Project): S;
  link(ctx: Ctx, state: S): void;
  afterRegisterAll?(ctx: Ctx): void;
}

// 状態型はアナライザごとに異なる(ProtoState/GoState/…)。異種混在の配列を 1 本で
// 回すため要素は any 状態で扱う(各エントリ内では register/link の型は整合している)。
// 順序は重要: proto を先頭にして RPC 索引を最初に作る。
const ANALYZERS: LanguageAnalyzer<any>[] = [
  {
    name: 'proto',
    register: registerProto,
    link: linkProto,
    afterRegisterAll: (ctx) => {
      // 生成スタブの復元は全プロジェクトの実 proto を登録し終えてから行う(走査順非依存)。
      for (const p of ctx.projects) registerGeneratedStubs(ctx, p);
    },
  },
  { name: 'go', register: registerGo, link: linkGo },
  { name: 'js', register: registerJs, link: linkJs },
  { name: 'ex', register: registerEx, link: linkEx },
  { name: 'py', register: registerPy, link: linkPy },
];

const GENERATED_FILE = /(\.pb\.(go|ts|js)|_pb2?\.(ts|js|py)|_pb\.d\.ts|_connect\.(ts|js)|_grpc(_web)?_pb\.(ts|js)|\.min\.js)$/;
const JS_FILE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const TEST_FILE = /(_test\.go|_test\.exs|\.test\.[jt]sx?|\.spec\.[jt]sx?|_test\.py|^test_.*\.py)$/;
// このディレクトリ配下は(ファイル名に関わらず)テストコード扱い。
// テストヘルパー(client.go 等)が本番の呼び出し元としてカウントされるのを防ぐ
const TEST_DIRS = new Set(['tests', 'test', '__tests__', 'e2e']);

/** rel がテストコードのパスか(規約ディレクトリ + config.testPaths)。 */
function isTestPath(rel: string, config: Config): boolean {
  const segs = rel.split('/');
  for (const seg of segs.slice(0, -1)) if (TEST_DIRS.has(seg)) return true;
  for (const pattern of config.testPaths ?? []) {
    if (pattern.includes('/')) {
      if (rel === pattern || rel.startsWith(pattern.replace(/\/+$/, '') + '/')) return true;
    } else if (segs.slice(0, -1).includes(pattern)) {
      return true;
    }
  }
  return false;
}

function loadConfig(rootAbs: string): Config {
  const file = path.join(rootAbs, 'strata.config.json');
  if (!fs.existsSync(file)) return {};
  try {
    // JSONC(// と /* */ コメント)を許容する。stripSource でコメントを空白化してから parse。
    const noComments = stripSource(fs.readFileSync(file, 'utf8'), 'js').noComments;
    const parsed = JSON.parse(noComments) as Config;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    throw new Error(`strata.config.json の解析に失敗しました: ${(err as Error).message}`);
  }
}

interface ProjectFlags {
  hasGo: boolean;
  hasJs: boolean;
  hasEx: boolean;
  hasPy: boolean;
}
interface WalkResult {
  files: string[]; // ws 相対(POSIX)
  projectRoots: Map<string, ProjectFlags>;
}

function walk(rootAbs: string, config: Config): WalkResult {
  const files: string[] = [];
  const projectRoots = new Map<string, ProjectFlags>();

  const visit = (dirAbs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    const names = new Set(entries.filter((e) => e.isFile()).map((e) => e.name));
    const hasGo = names.has('go.mod');
    const hasJs = names.has('package.json');
    const hasEx = names.has('mix.exs');
    const hasPy = names.has('pyproject.toml') || names.has('setup.py') || names.has('requirements.txt');
    if (hasGo || hasJs || hasEx || hasPy) projectRoots.set(rel, { hasGo, hasJs, hasEx, hasPy });

    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      // 複合プロジェクト: ワークスペース直下のシンボリックリンク(→リポジトリ)は辿る
      let isDir = entry.isDirectory();
      if (!isDir && rel === '' && entry.isSymbolicLink()) {
        try {
          isDir = fs.statSync(path.join(dirAbs, entry.name)).isDirectory();
        } catch {
          continue; // リンク切れ
        }
      }
      if (isDir) {
        if (SKIP_DIRS.has(entry.name)) continue;
        if (isExcluded(childRel, config, true)) continue;
        visit(path.join(dirAbs, entry.name), childRel);
      } else if (entry.isFile()) {
        if (isExcluded(childRel, config)) continue;
        files.push(childRel);
      }
    }
  };
  visit(rootAbs, '');
  files.sort();
  return { files, projectRoots };
}

function isSourceFile(
  rel: string,
  config: Config,
): 'go' | 'js' | 'elixir' | 'py' | 'gql' | 'proto' | 'gengrpc' | 'test' | undefined {
  const base = path.posix.basename(rel);
  if (base.endsWith('_grpc.pb.go')) return 'gengrpc'; // .proto ソースがない場合の定義復元に使う
  if (base.endsWith('.pb.ex')) return undefined; // Elixir の生成コード
  if (base.endsWith('_pb2.py') || base.endsWith('_pb2_grpc.py')) return undefined; // Python の生成コード
  if (GENERATED_FILE.test(base)) return undefined;
  if (!config.includeTests && (TEST_FILE.test(base) || isTestPath(rel, config)))
    return 'test'; // グラフからは除外、RPC のテスト呼び出し検出のみ
  if (base.endsWith('.d.ts')) return undefined;
  if (base.endsWith('.go')) return 'go';
  if (base.endsWith('.proto')) return 'proto';
  if (base.endsWith('.ex')) return 'elixir'; // .exs(スクリプト/テスト/設定)は対象外
  if (base.endsWith('.py')) return 'py';
  if (base.endsWith('.graphql') || base.endsWith('.gql') || base.endsWith('.graphqls')) return 'gql';
  if (JS_FILE.test(base)) return 'js';
  return undefined;
}

function readJsonSafe(file: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function readTextSafe(file: string): string | undefined {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return undefined;
  }
}

/**
 * マニフェストが宣言しているモジュール名。ディレクトリ名(basename)より正確なので優先する。
 * `<repo>/src` のような入れ子モジュールが全部 "src" になるのを避ける。
 */
function manifestName(dirAbs: string, flags: ProjectFlags): string | undefined {
  if (flags.hasJs) {
    const pkg = readJsonSafe(path.join(dirAbs, 'package.json'));
    if (pkg && typeof pkg.name === 'string' && pkg.name !== '') return pkg.name;
  }
  if (flags.hasGo) {
    const m = readTextSafe(path.join(dirAbs, 'go.mod'))?.match(/^\s*module\s+(\S+)/m);
    const segs = m ? m[1].replace(/\/+$/, '').split('/') : [];
    // 末尾がメジャー版区画なら 1 つ手前が通称。v0/v1 に接尾辞は付かない規約なので v2 以上だけ落とす
    if (segs.length > 1 && /^v[1-9]\d*$/.test(segs[segs.length - 1]) && segs[segs.length - 1] !== 'v1') segs.pop();
    if (segs.length > 0 && segs[segs.length - 1] !== '') return segs[segs.length - 1];
  }
  if (flags.hasEx) {
    const m = readTextSafe(path.join(dirAbs, 'mix.exs'))?.match(/\bapp:\s*:([A-Za-z_]\w*)/);
    if (m) return m[1];
  }
  if (flags.hasPy) {
    const m = readTextSafe(path.join(dirAbs, 'pyproject.toml'))?.match(/^\s*\[project\][^[]*?^\s*name\s*=\s*["\']([^"\']+)["\']/ms);
    if (m) return m[1];
  }
  return undefined;
}

/** サービス設定のうち rel を含む最長一致のものを返す。 */
export function discover(rootAbs: string): { config: Config; projects: Project[]; builder: Builder; wsName: string } {
  const config = loadConfig(rootAbs);
  const { files, projectRoots } = walk(rootAbs, config);

  const rootsSorted = [...projectRoots.keys()].sort((a, b) => b.length - a.length);
  const projects = new Map<string, Project>();
  for (const [rel, flags] of projectRoots) {
    const name =
      manifestName(path.join(rootAbs, rel), flags) ??
      (rel === '' ? path.basename(rootAbs) : path.posix.basename(rel));
    projects.set(rel, {
      rootRel: rel,
      nodeId: rel === '' ? '.' : rel,
      name,
      hasGo: flags.hasGo,
      hasJs: flags.hasJs,
      hasEx: flags.hasEx,
      hasPy: flags.hasPy,
      goFiles: [],
      jsFiles: [],
      exFiles: [],
      pyFiles: [],
      gqlFiles: [],
      openapiFiles: [],
      k8sFiles: [],
      protoFiles: [],
      genGrpcFiles: [],
      testFiles: [],
    });
  }
  // どのプロジェクトにも属さないファイル用の擬似プロジェクト
  const pseudo: Project = {
    rootRel: '', nodeId: '', name: '(workspace)',
    hasGo: false, hasJs: false, hasEx: false, hasPy: false,
    goFiles: [], jsFiles: [], exFiles: [], pyFiles: [], gqlFiles: [], openapiFiles: [], k8sFiles: [], protoFiles: [], genGrpcFiles: [], testFiles: [],
  };
  const hasWsRootProject = projects.has('');

  // どちらも無効なら 4KB 読みごと省く
  const dataEnabled = config.openapi?.enabled !== false || config.deploy?.enabled !== false;
  for (const rel of files) {
    // 仕様書はソースコードではないので isSourceFile の分類とは別に拾う
    const kind = isSourceFile(rel, config) ?? (dataEnabled ? classifyDataFile(path.join(rootAbs, rel), rel) : undefined);
    if (!kind) continue;
    let owner: Project | undefined;
    for (const rootRel of rootsSorted) {
      if (rootRel === '' || rel === rootRel || rel.startsWith(rootRel + '/')) {
        owner = projects.get(rootRel);
        break;
      }
    }
    if (!owner) owner = hasWsRootProject ? projects.get('') : pseudo;
    if (!owner) owner = pseudo;
    if (kind === 'go') owner.goFiles.push(rel);
    else if (kind === 'js') owner.jsFiles.push(rel);
    else if (kind === 'elixir') owner.exFiles.push(rel);
    else if (kind === 'py') owner.pyFiles.push(rel);
    else if (kind === 'gql') owner.gqlFiles.push(rel);
    else if (kind === 'openapi') owner.openapiFiles.push(rel);
    else if (kind === 'k8s') owner.k8sFiles.push(rel);
    else if (kind === 'gengrpc') owner.genGrpcFiles.push(rel);
    else if (kind === 'test') owner.testFiles.push(rel);
    else owner.protoFiles.push(rel);
  }

  const builder = new Builder();
  // サービスノード
  for (const svc of config.services ?? []) {
    builder.addNode({ id: svcNodeId(svc), label: svc.name, kind: 'service' });
  }
  // プロジェクト(モジュール)ノード
  const projectList = [...projects.values()].sort((a, b) => (a.rootRel < b.rootRel ? -1 : 1));
  // テストコードしか含まないモジュールはグラフに出さない(テスト呼び出し検出には使う)
  const emitted = projectList.filter(
    (p) =>
      p.goFiles.length + p.jsFiles.length + p.exFiles.length + p.pyFiles.length + p.gqlFiles.length +
        p.protoFiles.length + p.genGrpcFiles.length >
      0,
  );
  const emittedRoots = new Set(emitted.map((p) => p.rootRel));
  // ワークスペース直下に複数リポジトリを並べた構成でだけ、リポジトリ名のグループを暗黙に作る。
  // ルート自体がプロジェクト(単一リポジトリ)なら従来どおり平坦に置く
  const groupByRepo = !hasWsRootProject;
  const parentOf = (p: Project): string | undefined => {
    const svc = p.rootRel === '' ? undefined : serviceFor(p.rootRel, config);
    if (svc) return svcNodeId(svc);
    // 入れ子モジュールは上位のモジュールルートにぶら下げる(ws ルート自身は親にしない)
    for (let dir = path.posix.dirname(p.rootRel); dir !== '.' && dir !== ''; dir = path.posix.dirname(dir)) {
      if (emittedRoots.has(dir)) return dir;
    }
    const repo = p.rootRel.split('/')[0];
    return groupByRepo && repo !== '' && repo !== p.rootRel ? repo : undefined;
  };

  const parents = new Map(emitted.map((p) => [p.nodeId, parentOf(p)]));
  // 実体のないグループ(マニフェストを持たないリポジトリルート)をノードとして立てる
  const groups = new Set<string>();
  for (const parent of parents.values()) {
    if (parent !== undefined && !parent.startsWith('svc:') && !emittedRoots.has(parent)) groups.add(parent);
  }
  // 入れ子モジュールの親は「上位のモジュール」なので、グループまで親を辿って数える
  const groupOf = (nodeId: string): string | undefined => {
    let cur = parents.get(nodeId);
    for (let guard = 0; cur !== undefined && guard < 100; guard++) {
      if (groups.has(cur)) return cur;
      cur = parents.get(cur);
    }
    return undefined;
  };
  for (const g of [...groups].sort()) {
    // 配下のモジュールで最も多い言語をグループの言語にする(ビューアが箱を言語で塗り分ける)
    const tally = new Map<string, number>();
    for (const p of emitted) {
      if (groupOf(p.nodeId) !== g) continue;
      const lang = p.hasGo ? 'go' : p.hasEx ? 'ex' : p.hasPy ? 'py' : 'ts';
      tally.set(lang, (tally.get(lang) ?? 0) + 1);
    }
    let lang: string | undefined;
    let best = 0;
    for (const [k, n] of tally) if (n > best) ((best = n), (lang = k));
    builder.addNode({ id: g, label: path.posix.basename(g), kind: 'dir', ...(lang ? { lang } : {}) });
  }
  for (const p of emitted) {
    builder.addNode({
      id: p.nodeId,
      label: p.name,
      parent: parents.get(p.nodeId),
      kind: 'module',
      lang: p.hasGo ? 'go' : p.hasEx ? 'ex' : p.hasPy ? 'py' : 'ts',
    });
  }
  // 仕様書やマニフェストしか無い擬似プロジェクトも残す。
  // ソースコードだけで判定していたため、ワークスペース直下に置いた
  // openapi.yaml / k8s マニフェストが読まれずに消えていた
  const pseudoFiles =
    pseudo.goFiles.length +
    pseudo.jsFiles.length +
    pseudo.exFiles.length +
    pseudo.pyFiles.length +
    pseudo.gqlFiles.length +
    pseudo.openapiFiles.length +
    pseudo.k8sFiles.length +
    pseudo.protoFiles.length;
  if (pseudoFiles > 0) projectList.push(pseudo);

  const wsName = config.name ?? path.basename(rootAbs);
  return { config, projects: projectList, builder, wsName };
}

/**
 * 解決できなかった内部 import を 1 本の警告にまとめる。
 * 1 件ずつ出すと 50 リポジトリで 1,000 行になり、本物の警告が埋もれる。
 * 生成物への import は間接層が後で解決しているので、警告から外す(嘘の警告になる)。
 */
function reportUnresolvedImports(ctx: Ctx): void {
  if (ctx.unresolvedImports.size === 0) return;
  const explained: string[] = [];
  const rest: string[] = [];
  for (const p of [...ctx.unresolvedImports].sort()) {
    (ctx.artifactDirs.some((dir) => importMatchesDir(p, dir)) ? explained : rest).push(p);
  }
  if (explained.length > 0) {
    ctx.builder.warn(
      `生成クライアントへの import ${explained.length} 件は Go のパッケージとしては解決できませんでしたが、` +
        `間接層が呼び出し先の RPC を解決しています(警告ではありません)`,
    );
  }
  if (rest.length === 0) return;
  const head = rest.slice(0, 5).join(', ');
  ctx.builder.warn(
    `import が解決できません(module 名との不一致?): ${rest.length} 件 — ${head}` +
      (rest.length > 5 ? ` …他 ${rest.length - 5} 件` : ''),
  );
}

/** 解析台帳を組み立てる。数えていない項目を推測で埋めない(0 と「見ていない」を混ぜない)。 */
function buildCoverage(ctx: Ctx): Coverage {
  let viaArtifact = 0;
  for (const p of ctx.unresolvedImports) {
    if (ctx.artifactDirs.some((dir) => importMatchesDir(p, dir))) viaArtifact++;
  }
  return {
    files: { read: ctx.stats.filesRead, failed: ctx.stats.filesFailed },
    imports: {
      resolved: ctx.stats.importsResolved,
      unresolved: ctx.unresolvedImports.size - viaArtifact,
      viaArtifact,
    },
    rpcCalls: {
      evidence: ctx.rpcCalls.length,
      resolvedByIndirection: ctx.stats.rpcLinked,
      unresolved: ctx.unresolved.filter((u) => u.reason === 'artifact').length,
    },
    ambiguous: ctx.stats.ambiguous,
    analyzers: {
      indirection: ctx.config.indirection?.enabled === true,
      infra: ctx.config.infra?.enabled === true,
      http: ctx.config.http?.enabled !== false,
      graphql: ctx.config.graphql?.enabled !== false,
      messaging: ctx.config.messaging !== undefined,
    },
  };
}

export function scan(rootDir: string): Graph {
  const rootAbs = path.resolve(rootDir);
  if (!fs.existsSync(rootAbs) || !fs.statSync(rootAbs).isDirectory()) {
    throw new Error(`ディレクトリが見つかりません: ${rootAbs}`);
  }
  const { config, projects, builder, wsName } = discover(rootAbs);

  const ctx: Ctx = {
    rootAbs,
    builder,
    config,
    projects,
    goPkgOfImportPath: new Map(),
    goFuncsOfPkg: new Map(),
    goMethodsOfPkg: new Map(),
    goPkgRelIndex: new Map(),
    goModulePrefixes: new Set(),
    goPkgImplServices: new Map(),
    unresolvedImports: new Set(),
    stats: { filesRead: 0, filesFailed: 0, importsResolved: 0, ambiguous: 0, rpcLinked: 0 },
    artifactDirs: [],
    goImplTypeServices: new Map(),
    protoGoPackage: new Map(),
    protoGoPackageSuffix: new Map(),
    protoServiceNames: new Set(),
    rpcByName: new Map(),
    rpcByNameLower: new Map(),
    rpcOfProto: new Map(),
    deployHosts: new Map(),
    declaredRoutes: new Map(),
    protoFiles: [],
    protoByBase: new Map(),
    jsFileIds: new Set(),
    jsPackageByName: new Map(),
    jsExports: new Map(),
    jsProtoRefsOfProject: new Map(),
    jsProtoRefsOfFile: new Map(),
    rpcCalls: [],
    pendingTopics: [],
    unresolved: [],
  };

  // 登録フェーズ(ノードと索引を作る)→ 接続フェーズ(索引を使ってエッジを張る)。
  // ANALYZERS を順に回し、各アナライザで全プロジェクトを登録してから afterRegisterAll を挟む。
  const states = ANALYZERS.map((a) => {
    const s = ctx.projects.map((p) => a.register(ctx, p));
    a.afterRegisterAll?.(ctx);
    return s;
  });
  ANALYZERS.forEach((a, i) => {
    for (const s of states[i]) a.link(ctx, s);
  });
  linkTests(ctx); // rpcByName 索引が揃った後に実行する
  detectConfigSurface(ctx); // 各サービスの環境変数(設定サーフェス)を meta に付与
  detectMessaging(ctx); // Pub/Sub のトピック経由の依存(config.messaging がある時のみ)
  registerDeploy(ctx, ctx.projects); // ホスト名 → サービスの同定。detectHttp の宛先解決に使う
  registerOpenapi(ctx, ctx.projects); // 宣言された API。呼び出し解決の候補にするため detectHttp より先
  detectHttp(ctx); // HTTP(REST / webhook)のルートと呼び出し。関数ノードが揃った後に実行する
  linkOpenapi(ctx); // 宣言と実装の突き合わせ。ルートノードが揃った後に実行する
  detectGraphql(ctx); // GraphQL スキーマ・リゾルバ・操作・federation
  // フェーズ A(収集)→ フェーズ B(解決)。間接層を越えた呼び出しは全ノードが揃ってから繋ぐ
  collectRpcCallEvidence(ctx);
  resolveIndirection(ctx);
  resolveInfraTopics(ctx); // 環境変数経由のトピック名を IaC から逆引きする

  reportUnresolvedImports(ctx);
  const graph = builder.build(wsName, rootAbs);
  graph.coverage = buildCoverage(ctx);
  if (ctx.unresolved.length > 0) graph.unresolved = ctx.unresolved;
  if (ctx.config.forbidden && ctx.config.forbidden.length > 0) {
    graph.rules = ctx.config.forbidden;
    // 違反したエッジに印を付ける。ビューアはこれを見て図の線を変える(正本は strata check)
    markViolations(graph, ctx.config.forbidden);
  }
  if (ctx.config.thresholds) graph.thresholds = ctx.config.thresholds;
  return graph;
}

