// 依存モデルの型定義と Builder(docs/SPEC.md §7)

export type NodeKind =
  | 'service' | 'module' | 'dir' | 'package' | 'file' | 'proto' | 'func' | 'rpc' | 'topic'
  | 'route' // HTTP エンドポイント(REST / webhook)
  | 'gqlfield'; // GraphQL の Query / Mutation / Subscription フィールド
export type EdgeKind =
  | 'import' | 'call' | 'rpc' | 'impl' | 'proto' | 'event'
  | 'http' // HTTP 呼び出し(クライアント → ルート)
  | 'graphql'; // GraphQL 操作(クライアント → フィールド)、federation の参照

/**
 * ノードの付随情報。アナライザが書き込み、ビューア/レポート/CLI が読む。
 * 型なしバッグ(Record<string, unknown>)だとキーのスペルミスや欠落を検出できないため、
 * 既知のキーをここで列挙する。
 */
export interface NodeMeta {
  file?: string; // 定義ファイルの ws 相対パス
  line?: number; // 定義行(1 始まり)
  doc?: string; // 説明文(godoc / proto コメント等)
  entry?: 'main' | 'view'; // エントリーポイント種別(プロセス起動点 / LiveView 画面)
  events?: string[]; // LiveView の handle_event 名
  req?: string; // RPC の request メッセージ型
  res?: string; // RPC の response メッセージ型
  deprecated?: boolean; // RPC が deprecated
  streaming?: 'bidi' | 'client' | 'server'; // RPC のストリーミング種別
  pkg?: string; // proto の package 名
  services?: string[]; // proto が定義する service 名
  goPackage?: string; // proto の go_package
  messages?: Record<string, number>; // proto の message 名 → 定義行
  generated?: boolean; // 生成スタブから復元した proto
  typeDefs?: Record<string, { f: string; l: number }>; // 型定義名 → 定義位置(定義ジャンプ用)
  testCallers?: number; // この RPC を呼ぶテストファイル数
  testFiles?: string[]; // 呼び出し元テストファイル(上限あり)
  interceptors?: string[]; // gRPC サーバのインターセプタ(認可等の横断ミドルウェア)
  envVars?: string[]; // このサービスが読み取る環境変数(設定サーフェス)
  // HTTP(route ノード)
  method?: string; // GET / POST / ANY など
  path?: string; // 正規化済みパス(/api/orders/{})
  framework?: string; // gin / echo / chi / mux / net/http / express / fastify / hono / next / fastapi / flask / phoenix
  webhook?: boolean; // webhook の受信口 / 送信先
  inlineHandler?: boolean; // ハンドラがその場の無名関数(実装ノードを名前で引けない)
  external?: boolean; // 自リポジトリ外(外部システム)を表すノード
  // GraphQL(gqlfield ノード / スキーマファイル)
  gqlKind?: 'query' | 'mutation' | 'subscription'; // ルート種別
  gqlType?: string; // 戻り値の型
  entities?: Record<string, string>; // federation のエンティティ型 → @key(fields)
  subgraph?: string; // サブグラフ名(スキーマを持つサービス/モジュール)
}

export interface GNode {
  id: string;
  label: string;
  parent?: string;
  kind: NodeKind;
  lang?: string;
  loc?: number;
  meta?: NodeMeta;
}

export interface GEdge {
  from: string;
  to: string;
  count: number;
  kind: EdgeKind;
  /** 呼び出し箇所(最大5件)。ビューアの「呼び出し元行へジャンプ」に使う */
  sites?: Array<{ f: string; l: number }>;
}

/**
 * 禁止依存ルール(アーキテクチャ fitness function)。
 * from にマッチするノード(またはその祖先)から to にマッチするノードへの
 * エッジがあれば違反。from/to はノード id/ラベルへのグロブ(*)または部分一致。
 */
export interface ForbiddenRule {
  name?: string;
  from: string;
  to: string;
  comment?: string;
}

/** アーキテクチャの数値しきい値(check で超過を fail させる fitness function)。 */
export interface Thresholds {
  maxCycles?: number; // 循環グループ数の上限
  maxInstability?: number; // 各サービスの不安定度 I の上限(0..1)
  maxEfferent?: number; // 各サービスの依存先数 Ce の上限
}

export interface Graph {
  tool: string;
  name: string;
  root: string;
  createdAt: string;
  nodes: GNode[];
  edges: GEdge[];
  warnings: string[];
  rules?: ForbiddenRule[]; // strata.config.json の forbidden(あれば埋め込む)
  thresholds?: Thresholds; // strata.config.json の thresholds(あれば埋め込む)
}

/** ツールのバージョン。リリースタグと package.json の version と必ず一致させる
 *  (test/cli.smoke.mjs が 3 者の一致を検査する)。 */
export const VERSION = '0.1.0';
export const TOOL_VERSION = `strata ${VERSION}`;

/**
 * JSON テキストを Graph として読み込み、最低限の構造を検証する。
 * 壊れた JSON や別形式のファイルを渡したときに、後段での不明瞭な undefined 参照
 * ではなく明瞭なエラーにする。source はエラーメッセージ用のファイル名。
 */
export function parseGraph(text: string, source: string): Graph {
  let obj: unknown;
  try {
    obj = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source} は正しい JSON ではありません: ${(err as Error).message}`);
  }
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`${source} が Strata モデルの形式ではありません(オブジェクトではありません)`);
  }
  const g = obj as Partial<Graph>;
  if (typeof g.tool !== 'string' || !Array.isArray(g.nodes) || !Array.isArray(g.edges)) {
    throw new Error(
      `${source} は Strata モデルの形式ではありません(tool/nodes/edges が必要です)。` +
        `strata scan で生成した model.json を渡してください。`,
    );
  }
  // 任意フィールドの欠落を埋めて後段の参照を安全にする
  return {
    tool: g.tool,
    name: typeof g.name === 'string' ? g.name : '',
    root: typeof g.root === 'string' ? g.root : '',
    createdAt: typeof g.createdAt === 'string' ? g.createdAt : '',
    nodes: g.nodes as GNode[],
    edges: g.edges as GEdge[],
    warnings: Array.isArray(g.warnings) ? (g.warnings as string[]) : [],
    ...(Array.isArray(g.rules) ? { rules: g.rules as ForbiddenRule[] } : {}),
    ...(g.thresholds && typeof g.thresholds === 'object' ? { thresholds: g.thresholds as Thresholds } : {}),
  };
}

export class Builder {
  nodes = new Map<string, GNode>();
  edges = new Map<string, GEdge>();
  warnings: string[] = [];

  addNode(n: GNode): GNode {
    const parent = n.parent === '' ? undefined : n.parent;
    const existing = this.nodes.get(n.id);
    if (existing) {
      if (n.loc) existing.loc = (existing.loc ?? 0) + n.loc;
      if (n.meta) existing.meta = { ...existing.meta, ...n.meta };
      return existing;
    }
    const node: GNode = { ...n, parent };
    this.nodes.set(node.id, node);
    return node;
  }

  get(id: string): GNode | undefined {
    return this.nodes.get(id);
  }

  addLoc(id: string, loc: number): void {
    const n = this.nodes.get(id);
    if (n) n.loc = (n.loc ?? 0) + loc;
  }

  /**
   * baseId(既存ノード)配下に wsRelDir までの dir ノード連鎖を作る。
   * baseWsRel はワークスペース相対での基点パス('' = ワークスペース直下)。
   * ノード ID はワークスペース相対パスをそのまま使う。
   */
  ensureDirChain(wsRelDir: string, baseWsRel: string, baseId: string): string {
    if (wsRelDir === baseWsRel) return baseId;
    const rest = baseWsRel === '' ? wsRelDir : wsRelDir.slice(baseWsRel.length + 1);
    let parent = baseId;
    let cur = baseWsRel;
    for (const seg of rest.split('/')) {
      cur = cur === '' ? seg : cur + '/' + seg;
      this.addNode({ id: cur, label: seg, parent, kind: 'dir' });
      parent = cur;
    }
    return parent;
  }

  addEdge(from: string, to: string, kind: EdgeKind, count = 1, site?: { f: string; l: number }): void {
    if (from === to || !from || !to) return;
    const key = from + ' ' + to + ' ' + kind;
    let edge = this.edges.get(key);
    if (edge) {
      edge.count += count;
    } else {
      edge = { from, to, count, kind };
      this.edges.set(key, edge);
    }
    if (site) {
      if (!edge.sites) edge.sites = [];
      if (edge.sites.length < 5 && !edge.sites.some((s) => s.f === site.f && s.l === site.l)) {
        edge.sites.push(site);
      }
    }
  }

  warn(message: string): void {
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }

  build(name: string, root: string): Graph {
    const nodes = [...this.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const edges = [...this.edges.values()].sort((a, b) => {
      const ka = a.from + ' ' + a.to + ' ' + a.kind;
      const kb = b.from + ' ' + b.to + ' ' + b.kind;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return {
      tool: TOOL_VERSION,
      name,
      root,
      createdAt: new Date().toISOString(),
      nodes,
      edges,
      warnings: this.warnings.slice().sort(),
    };
  }
}
