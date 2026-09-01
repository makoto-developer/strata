// フェーズ B(解決): 集めた呼び出し証拠を proto の RPC 定義に突き合わせて線を張る。
//
// 解決は「証拠が強い順」に試し、決め手が無ければ繋がずに未解決として残す
// (誤検出より取りこぼしを優先する既存方針)。
//
//   1. 完全修飾一致: 呼び出し元が import している生成物の "package.Service.Method" が一意に一致する
//   2. 短名一致    : 生成物を特定できないときだけ、"Service.Method" が全体で一意なら接続する
//   3. 設定       : 1・2 で解けない構成のための逃げ道(packageComment / namingConvention / manifest)
//
// package を落とした短名は「安全な一意性」ではない(別組織の同名 API に化ける)。
// そのため生成物を特定できた呼び出しでは、完全修飾で一致しない限り繋がない。

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  discoverGeneratedArtifacts,
  fullRpcName,
  servicesOf,
  type ArtifactMethod,
  type GeneratedArtifact,
} from './generated-artifact.ts';
import { addUnresolved, type Ctx, type IndirectionPattern, type RpcCallEvidence, type RpcInfo } from './context.ts';
import { globToRegex } from './path-glob.ts';

/**
 * RPC 名の索引。完全修飾(package 込み)を第一のキーにし、短名は生成物を特定できないときの
 * フォールバックにだけ使う。TS の lowerCamel 表記も同じ表に入れる。
 */
interface RpcIndex {
  byFull: Map<string, RpcInfo[]>;
  byShort: Map<string, RpcInfo[]>;
}

function lowerCamel(name: string): string {
  return name === '' ? name : name[0].toLowerCase() + name.slice(1);
}

function pushIndex(map: Map<string, RpcInfo[]>, key: string, info: RpcInfo): void {
  const list = map.get(key);
  if (list) {
    if (!list.some((i) => i.rpcId === info.rpcId)) list.push(info);
    return;
  }
  map.set(key, [info]);
}

/** 1 つの RPC を、完全修飾・短名の両方(原形と lowerCamel)で索引に入れる。 */
function indexRpc(index: RpcIndex, pkg: string, info: RpcInfo): void {
  const prefix = pkg === '' ? '' : pkg + '.';
  for (const method of new Set([info.name, lowerCamel(info.name)])) {
    pushIndex(index.byFull, `${prefix}${info.service}.${method}`, info);
    pushIndex(index.byShort, `${info.service}.${method}`, info);
  }
}

function buildRpcIndex(ctx: Ctx): RpcIndex {
  const index: RpcIndex = { byFull: new Map(), byShort: new Map() };
  for (const [protoId, rpcMap] of ctx.rpcOfProto) {
    const pkg = ctx.builder.get(protoId)?.meta?.pkg ?? '';
    for (const info of rpcMap.values()) indexRpc(index, pkg, info);
  }
  return index;
}

/** artifact のディレクトリと import パスの末尾が一致するか(パス規約を前提にしない緩い突合)。 */
function importMatchesDir(importPath: string, dir: string): boolean {
  const segs = dir.split('/').filter((s) => s !== '');
  if (segs.length === 0) return false;
  const tail = segs.slice(-Math.min(segs.length, 3)).join('/');
  return importPath === tail || importPath.endsWith('/' + tail);
}

/** この呼び出し元が実際に import していて、かつ当該 service を宣言している生成物。 */
function artifactsFor(ev: RpcCallEvidence, artifacts: GeneratedArtifact[]): GeneratedArtifact[] {
  return artifacts.filter(
    (a) => servicesOf(a).has(ev.service) && (ev.importPaths ?? []).some((p) => importMatchesDir(p, a.dir)),
  );
}

function methodMatches(m: ArtifactMethod, ev: RpcCallEvidence): boolean {
  return m.service === ev.service && (m.method === ev.method || lowerCamel(m.method) === ev.method);
}

/**
 * 生成物を置くディレクトリノードを返す。トップレベルに置くと
 * 「生成クライアントのパッケージ数 = 図の箱数」になって図が破綻するため、必ず親を与える。
 */
function artifactParent(ctx: Ctx, dir: string): string | undefined {
  const parentDir = path.posix.dirname(dir);
  if (parentDir === '.' || parentDir === '') return undefined;
  let base = '';
  for (let cur = parentDir; cur !== '' && cur !== '.'; cur = path.posix.dirname(cur)) {
    if (ctx.builder.get(cur)) {
      base = cur;
      break;
    }
  }
  return ctx.builder.ensureDirChain(parentDir, base, base);
}

/** 生成物ノードを立て、元 proto から generates エッジ(contract → artifact)を張る。 */
function registerArtifacts(ctx: Ctx, artifacts: GeneratedArtifact[], index: RpcIndex): void {
  for (const artifact of artifacts) {
    const protoIds = new Set<string>();
    for (const m of artifact.methods) {
      for (const info of index.byFull.get(fullRpcName(m)) ?? []) protoIds.add(info.protoId);
    }
    ctx.builder.addNode({
      id: artifact.id,
      label: path.posix.basename(artifact.dir) || artifact.dir,
      parent: artifactParent(ctx, artifact.dir),
      kind: 'artifact',
      meta: {
        file: artifact.files[0],
        line: 1,
        ...(artifact.methods[0]?.pkg ? { pkg: artifact.methods[0].pkg } : {}),
        services: [...servicesOf(artifact)].sort(),
      },
    });
    for (const protoId of protoIds) ctx.builder.addEdge(protoId, artifact.id, 'generates', 1);
  }
}

/**
 * ワークスペースに元 proto が無い生成物は、その生成物自身を API 定義として登録する
 * (proto が別リポジトリにあり、手元には生成クライアントしか無い構成の救済)。
 * 判定は完全修飾名で行う — 短名で見ると、package の違う無関係な proto に吸収される。
 */
function registerArtifactOnlyRpcs(ctx: Ctx, artifacts: GeneratedArtifact[], index: RpcIndex): number {
  let added = 0;
  for (const artifact of artifacts) {
    for (const m of artifact.methods) {
      if ((index.byFull.get(fullRpcName(m)) ?? []).length > 0) continue;
      const rpcId = `${artifact.id}#${m.service}.${m.method}`;
      ctx.builder.addNode({
        id: rpcId,
        label: `${m.service}.${m.method}`,
        parent: artifact.id,
        kind: 'rpc',
        meta: { file: artifact.files[0], line: 1, generated: true, ...(m.pkg ? { pkg: m.pkg } : {}) },
      });
      indexRpc(index, m.pkg, { rpcId, protoId: artifact.id, service: m.service, name: m.method });
      added++;
    }
  }
  return added;
}

/** namingConvention テンプレートから service 名を取り出す。失敗したら undefined。 */
function serviceFromTemplate(template: string, importPath: string): string | undefined {
  const names: string[] = [];
  const re = template
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      names.push(m[1]);
      return '([^/]+)';
    })
    .join('');
  const match = new RegExp('(?:^|/)' + re + '(?:/|$)').exec(importPath);
  if (!match) return undefined;
  const at = names.indexOf('service');
  return at >= 0 ? match[at + 1] : undefined;
}

/** manifest(生成物 → proto の対応表)を読む。読めない・壊れているときは空。 */
function readManifest(ctx: Ctx, rel: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(path.join(ctx.rootAbs, rel), 'utf8'));
    if (!parsed || typeof parsed !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** 設定パターンによる解決。1 つが失敗しても例外にせず undefined を返して次へ進む。 */
function resolveByPattern(
  ctx: Ctx,
  pattern: IndirectionPattern,
  ev: RpcCallEvidence,
  index: RpcIndex,
): RpcInfo | undefined {
  const rx = globToRegex(pattern.importPathPattern);
  const hit = (ev.importPaths ?? []).find((p) => rx.test(p));
  if (hit === undefined) return undefined;
  let key: string | undefined;
  if (pattern.resolveVia === 'namingConvention') {
    const service = pattern.namingConvention
      ? serviceFromTemplate(pattern.namingConvention.importPathToService, hit)
      : undefined;
    key = service === undefined ? undefined : `${service}.${ev.method}`;
  } else if (pattern.resolveVia === 'manifest') {
    // マニフェストは import パス → proto の package を返す(完全修飾で引き直す)
    const mapped = pattern.manifest ? readManifest(ctx, pattern.manifest.path)[hit] : undefined;
    key = mapped === undefined ? undefined : `${mapped}.${ev.service}.${ev.method}`;
  } else {
    // packageComment: 生成物のヘッダから復元済みの service 名をそのまま使う
    key = `${ev.service}.${ev.method}`;
  }
  if (key === undefined) return undefined;
  const candidates = index.byFull.get(key) ?? index.byShort.get(key) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

interface Resolution {
  info: RpcInfo;
  via: string[];
}

/** 1 件の証拠を解決する。決め手が無ければ null(未解決として残す)。 */
function resolveEvidence(
  ctx: Ctx,
  ev: RpcCallEvidence,
  index: RpcIndex,
  artifacts: GeneratedArtifact[],
): Resolution | null {
  const matched = artifactsFor(ev, artifacts);
  for (const artifact of matched) {
    for (const m of artifact.methods.filter((x) => methodMatches(x, ev))) {
      const candidates = index.byFull.get(fullRpcName(m)) ?? [];
      if (candidates.length === 1) return { info: candidates[0], via: [artifact.id] };
    }
  }
  // 生成物を特定できたのに完全修飾で解けないときは、別 package の同名 API の可能性がある。繋がない
  if (matched.length > 0) return null;
  // 明示設定は短名より先に試す。短名が曖昧なときこそ patterns で決着させたいため
  for (const pattern of ctx.config.indirection?.patterns ?? []) {
    const info = resolveByPattern(ctx, pattern, ev, index);
    if (info) return { info, via: [] };
  }
  const short = index.byShort.get(`${ev.service}.${ev.method}`) ?? [];
  // 型注釈だけの束縛でも、修飾子の import が proto に解決できるならその proto に限って引く
  // (`orderv1.OrderServiceClient` の orderv1 が実在の proto を指しているなら強い証拠)
  if (!ev.fromConstructor) {
    const protoId = ev.qualifierPath === undefined ? undefined : ctx.protoGoPackage.get(ev.qualifierPath);
    if (protoId === undefined) return null;
    const scoped = short.filter((i) => i.protoId === protoId);
    return scoped.length === 1 ? { info: scoped[0], via: [] } : null;
  }
  // 短名だけの一致は弱い証拠。生成クライアントのコンストラクタで掴んだ呼び出しに限る
  return short.length === 1 ? { info: short[0], via: [] } : null;
}

function hintFor(ev: RpcCallEvidence, index: RpcIndex, hadArtifact: boolean): string {
  const name = `${ev.service}.${ev.method}`;
  const short = (index.byShort.get(name) ?? []).length;
  if (hadArtifact) {
    return `${name} は import している生成物の package と一致する proto がありません(別 API の可能性)。` +
      `生成物の package を確認してください`;
  }
  if (short > 1) {
    return `${name} に一致する proto が複数あります。生成物を解析対象に含めるか、` +
      `indirection.patterns で import パスから package を特定してください`;
  }
  if (short === 1 && !ev.fromConstructor) {
    return `${name} は型注釈だけで掴まれており、生成クライアントである証拠がありません` +
      `(手書き interface やモックと区別できないため繋いでいません)`;
  }
  return `${name} に一致する proto がワークスペース内にありません。` +
    `生成クライアントを解析対象に含めるか、indirection.patterns を設定してください`;
}

function topAncestor(ctx: Ctx, id: string): string {
  let cur = id;
  for (let guard = 0; guard < 200; guard++) {
    const node = ctx.builder.get(cur);
    if (!node || !node.parent) return cur;
    cur = node.parent;
  }
  return cur;
}

/** その実装関数に「gRPC サーバとして登録している」証拠があるか(Unimplemented<Service>Server の埋め込み)。 */
function hasServerEvidence(ctx: Ctx, funcId: string, rpcLabel: string): boolean {
  const hash = funcId.indexOf('#');
  if (hash < 0) return false;
  const service = rpcLabel.includes('.') ? rpcLabel.slice(0, rpcLabel.indexOf('.')) : rpcLabel;
  return ctx.goPkgImplServices.get(funcId.slice(0, hash))?.has(service) === true;
}

/**
 * 中継「候補」を検出して印を付ける。
 * 「ある RPC をサーバとして実装しつつ、その同じ RPC を自分でも呼んでいる」層は素通しの中継の可能性が高い。
 * サーバ登録の証拠を必須にしているのは、同名メソッドを持つだけのクライアントラッパーを
 * 中継と誤認しないため(ストリーミングのラッパーで実際に誤検出した)。証拠を取れない言語では印を付けない。
 * ただし静的解析で分かるのはここまで — 候補が複数あっても直列とは限らず(別環境の代替経路・
 * 並列の入口のこともある)、層数・順序・呼び出し元の到達先は主張できない。
 */
function markRelayCandidates(ctx: Ctx): number {
  const implemented = new Map<string, Set<string>>(); // 最上位ノード -> 実装している RPC ノード id
  const called = new Map<string, Set<string>>(); // 最上位ノード -> 呼んでいる RPC ノード id
  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    let set = map.get(key);
    if (!set) {
      set = new Set();
      map.set(key, set);
    }
    set.add(value);
  };
  for (const e of ctx.builder.edges.values()) {
    if (e.kind === 'impl') {
      if (!hasServerEvidence(ctx, e.to, ctx.builder.get(e.from)?.label ?? '')) continue;
      add(implemented, topAncestor(ctx, e.to), e.from);
    } else if (e.kind === 'rpc') {
      add(called, topAncestor(ctx, e.from), e.to);
    }
  }
  let marked = 0;
  for (const [id, rpcs] of implemented) {
    const outgoing = called.get(id);
    if (!outgoing || ![...rpcs].some((r) => outgoing.has(r))) continue;
    const node = ctx.builder.get(id);
    if (!node || node.meta?.relayCandidate) continue;
    node.meta = { ...node.meta, relayCandidate: true };
    marked++;
  }
  return marked;
}

/**
 * サーバ実装を RPC に繋ぐ。
 *
 * golang.ts の実装検出は「解決済みの proto を import しているファイル」が前提だが、
 * 生成クライアントが別リポジトリにある構成では import が間接層でしか解けず、実装側だけが
 * 繋がらないまま残る。すると呼び出しの矢印が実装サービスに届かず、共有 proto の箱に集まる。
 * ここでは Unimplemented<Service>Server の埋め込み(生成コード由来の強い証拠)を起点に繋ぎ直す。
 */
function linkServerImpls(ctx: Ctx, index: RpcIndex): number {
  // service -> それを実装している型の funcId 接頭辞("pkgId#Type")
  const ownersOf = new Map<string, string[]>();
  for (const [typeKey, services] of ctx.goImplTypeServices) {
    for (const service of services) {
      const list = ownersOf.get(service);
      if (list) list.push(typeKey);
      else ownersOf.set(service, [typeKey]);
    }
  }
  if (ownersOf.size === 0) return 0;

  // 1 つの RPC を複数のサービスが実装することはある(共有 contract の別実装)。
  // 重複判定は「その RPC が繋がっているか」ではなく、この辺そのものの有無で行う
  const existing = new Set<string>();
  for (const e of ctx.builder.edges.values()) if (e.kind === 'impl') existing.add(`${e.from}\u0000${e.to}`);

  let linked = 0;
  for (const [key, infos] of index.byShort) {
    const dot = key.indexOf('.');
    const owners = ownersOf.get(key.slice(0, dot));
    // 同じ Service.Method が複数の proto にあるなら取り違えるので繋がない
    if (!owners || infos.length !== 1) continue;
    for (const owner of owners) {
      const funcId = `${owner}.${key.slice(dot + 1)}`;
      if (!ctx.builder.get(funcId) || existing.has(`${infos[0].rpcId}\u0000${funcId}`)) continue;
      ctx.builder.addEdge(infos[0].rpcId, funcId, 'impl');
      existing.add(`${infos[0].rpcId}\u0000${funcId}`);
      linked++;
    }
  }
  return linked;
}

/** 解決した証拠をエッジにする(経由地があれば via / hops を残す)。 */
function linkResolved(ctx: Ctx, ev: RpcCallEvidence, res: Resolution): void {
  const site = { f: ev.file, l: ev.line };
  for (const from of [ev.from, ...(ev.funcId ? [ev.funcId] : [])]) {
    const edge = ctx.builder.addEdge(from, res.info.rpcId, 'rpc', 1, site);
    if (!edge || res.via.length === 0) continue;
    // 同じ from/to のエッジは 1 本にまとまるので、経由地は上書きせず足し合わせる
    edge.via = [...new Set([...(edge.via ?? []), ...res.via])].sort();
  }
}

/**
 * 間接層の解決。config.indirection.enabled のときだけ動く(既定は無効)。
 * patterns は必須ではない — 設定が enabled だけでも、生成物の署名とシンボル一致で解決を試みる。
 */
export function resolveIndirection(ctx: Ctx): void {
  if (!ctx.config.indirection?.enabled) return;
  const index = buildRpcIndex(ctx);
  const artifacts = discoverGeneratedArtifacts(ctx.rootAbs, ctx.config);
  registerArtifacts(ctx, artifacts, index);
  const recovered = registerArtifactOnlyRpcs(ctx, artifacts, index);
  const impls = linkServerImpls(ctx, index);

  let linked = 0;
  for (const ev of ctx.rpcCalls) {
    const res = resolveEvidence(ctx, ev, index, artifacts);
    if (res === null) {
      addUnresolved(ctx, {
        reason: 'artifact',
        from: ev.from,
        detail: `${ev.service}.${ev.method}`,
        file: ev.file,
        line: ev.line,
        hint: hintFor(ev, index, artifactsFor(ev, artifacts).length > 0),
      });
      continue;
    }
    linkResolved(ctx, ev, res);
    linked++;
  }

  const relays = markRelayCandidates(ctx);
  if (artifacts.length > 0) {
    ctx.builder.warn(`生成クライアント(生成物)を ${artifacts.length} 個検出しました(署名で同定)`);
  }
  if (recovered > 0) {
    ctx.builder.warn(`元 proto が見つからない生成物から RPC 定義を ${recovered} 件復元しました`);
  }
  if (linked > 0) {
    ctx.builder.warn(`間接層を越えた RPC 呼び出しを ${linked} 件接続しました`);
  }
  if (impls > 0) {
    ctx.builder.warn(
      `生成クライアント経由の構成で、サーバ実装を ${impls} 件 RPC に接続しました` +
        `(Unimplemented<Service>Server の埋め込みを証拠に同定)`,
    );
  }
  if (relays > 0) {
    ctx.builder.warn(
      `中継候補(同じ RPC を実装しつつ自分でも呼ぶ層)を ${relays} 件検出しました` +
        `(実際の通信経路・層数は静的には決まりません)`,
    );
  }
}

// テスト用に個別関数も公開
export { buildRpcIndex, serviceFromTemplate, importMatchesDir };
