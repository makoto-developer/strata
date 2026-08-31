// 非同期(Pub/Sub)連携の検出(docs/SPEC.md §6.8)。
// コールグラフに現れないメッセージキュー経由の依存を補完する。
// strata.config.json の messaging.publish / messaging.subscribe にメソッド名を指定すると、
//   <recv>.<method>("topic", ...) を検出し、トピックノードと publisher→topic→subscriber の
//   イベント辺(kind:'event')を張る。誤検出を避けるため既定は無効(opt-in)。
//
// トピック名がリテラルでない場合(環境変数経由・実行時組み立て)は、ここでは繋がず
// ctx.pendingTopics に積む。環境変数は infra.ts が IaC から逆引きして解決する。
//
// 例: { "messaging": { "publish": ["Publish","Emit"], "subscribe": ["Subscribe","On"] } }

import { readFileText, type Ctx, type Project } from '../context.ts';

function topAncestorId(ctx: Ctx, id: string): string {
  let cur = id;
  for (let guard = 0; guard < 200; guard++) {
    const node = ctx.builder.get(cur);
    if (!node || !node.parent) return cur;
    cur = node.parent;
  }
  return cur;
}

// 第 1 引数から環境変数名を取り出す読み取り方(言語横断)。config.ts の一覧と対応させる
const ENV_READ = [
  /^(?:os\.)?(?:Getenv|LookupEnv)\(\s*["']([A-Za-z_]\w*)["']/,
  /^getEnv\(\s*["']([A-Za-z_]\w*)["']/,
  /^process\.env\.([A-Za-z_]\w*)/,
  /^process\.env\[\s*["']([A-Za-z0-9_]+)["']\s*\]/,
  /^System\.(?:get_env|fetch_env!?)\(\s*["']([A-Za-z_]\w*)["']/,
  /^os\.(?:getenv|environ\.get)\(\s*["']([A-Za-z_]\w*)["']/,
  /^os\.environ\[\s*["']([A-Za-z_]\w*)["']\s*\]/,
];

/** ローカル変数への環境変数代入(`topic := os.Getenv("X")` など)。変数名 -> 環境変数名。 */
function envVarsOfLocals(src: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /\b(\w+)\s*(?::=|=)\s*([^\n;]+)/g;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const rhs = m[2].trim();
    for (const envRe of ENV_READ) {
      const hit = envRe.exec(rhs);
      if (hit && !out.has(m[1])) out.set(m[1], hit[1]);
    }
  }
  return out;
}

type TopicRef =
  | { kind: 'literal'; topic: string; line: number }
  | { kind: 'env'; envVar: string; line: number }
  | { kind: 'dynamic'; expr: string; line: number };

/**
 * `(` の直後から第 1 引数を切り出す。クォート内の `,` や `)` を区切りと誤認しないよう、
 * 引用状態と括弧の深さを見る(単純な [^,)]* だと "tenant,audit" のようなトピック名を落とす)。
 */
function firstArg(src: string, open: number): string {
  let depth = 0;
  let quote = '';
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (quote !== '') {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0) return src.slice(open, i);
      depth--;
    } else if (ch === ',' && depth === 0) return src.slice(open, i);
  }
  return src.slice(open);
}

/** src から <method>( の第 1 引数を拾い、リテラル / 環境変数 / 動的生成に分類する。 */
function findTopicRefs(src: string, methods: string[], locals: Map<string, string>): TopicRef[] {
  const out: TopicRef[] = [];
  if (methods.length === 0) return out;
  const names = methods.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\.(?:${names})\\s*\\(`, 'g');
  const lineOf = (index: number): number => src.slice(0, index).split('\n').length;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const arg = firstArg(src, m.index + m[0].length).trim();
    const line = lineOf(m.index);
    const literal = /^["'`]([^"'`]+)["'`]$/.exec(arg);
    if (literal) {
      out.push({ kind: 'literal', topic: literal[1], line });
      continue;
    }
    const env = ENV_READ.map((r) => r.exec(arg)).find((hit) => hit !== null);
    if (env) {
      out.push({ kind: 'env', envVar: env[1], line });
      continue;
    }
    const local = locals.get(arg);
    if (local !== undefined) {
      out.push({ kind: 'env', envVar: local, line });
      continue;
    }
    if (arg !== '') out.push({ kind: 'dynamic', expr: arg, line });
  }
  return out;
}

/** publisher / subscriber を溜める入れ物。topic -> サービスノード id。 */
type TopicSides = Map<string, Set<string>>;

function addSide(map: TopicSides, topic: string, svc: string): void {
  let set = map.get(topic);
  if (!set) {
    set = new Set();
    map.set(topic, set);
  }
  set.add(svc);
}

/** 1 ファイル分の検出結果を publishers / subscribers / pendingTopics へ振り分ける。 */
function collectFile(
  ctx: Ctx,
  where: { svc: string; wsRel: string; src: string },
  sides: { publishers: TopicSides; subscribers: TopicSides },
): void {
  const cfg = ctx.config.messaging;
  const locals = envVarsOfLocals(where.src);
  const roles: Array<{ role: 'publish' | 'subscribe'; methods: string[]; target: TopicSides }> = [
    { role: 'publish', methods: cfg?.publish ?? [], target: sides.publishers },
    { role: 'subscribe', methods: cfg?.subscribe ?? [], target: sides.subscribers },
  ];
  // infra が無効なら、リテラル以外は従来どおり無視する(設定が無ければ未解決も増やさない)
  const collectPending = ctx.config.infra?.enabled === true;
  for (const { role, methods, target } of roles) {
    for (const ref of findTopicRefs(where.src, methods, locals)) {
      if (ref.kind === 'literal') {
        addSide(target, ref.topic, where.svc);
      } else if (!collectPending) {
        continue;
      } else if (ref.kind === 'env') {
        ctx.pendingTopics.push({ from: where.svc, role, envVar: ref.envVar, file: where.wsRel, line: ref.line });
      } else {
        ctx.pendingTopics.push({ from: where.svc, role, expr: ref.expr, file: where.wsRel, line: ref.line });
      }
    }
  }
}

/** トピックノードと publisher → topic → subscriber のイベント辺を張る。 */
export function linkTopics(ctx: Ctx, publishers: TopicSides, subscribers: TopicSides): void {
  for (const topic of new Set([...publishers.keys(), ...subscribers.keys()])) {
    const topicId = 'topic:' + topic;
    ctx.builder.addNode({ id: topicId, label: topic, kind: 'topic', meta: { line: 1 } });
    for (const pub of publishers.get(topic) ?? []) ctx.builder.addEdge(pub, topicId, 'event', 1);
    for (const sub of subscribers.get(topic) ?? []) ctx.builder.addEdge(topicId, sub, 'event', 1);
  }
}

export function detectMessaging(ctx: Ctx): void {
  const cfg = ctx.config.messaging;
  if (!cfg || ((cfg.publish?.length ?? 0) === 0 && (cfg.subscribe?.length ?? 0) === 0)) return;
  const sides = { publishers: new Map() as TopicSides, subscribers: new Map() as TopicSides };

  for (const project of ctx.projects) {
    if (project.nodeId === '') continue;
    const svc = topAncestorId(ctx, project.nodeId);
    const files = [...project.goFiles, ...project.jsFiles, ...project.exFiles, ...project.pyFiles];
    for (const wsRel of files) {
      let src: string;
      try {
        src = readFileText(ctx, wsRel);
      } catch {
        continue;
      }
      collectFile(ctx, { svc, wsRel, src }, sides);
    }
  }

  linkTopics(ctx, sides.publishers, sides.subscribers);
}

// テスト用に個別関数も公開
export { findTopicRefs, envVarsOfLocals };
export type { TopicRef, TopicSides };
