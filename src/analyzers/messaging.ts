// 非同期(Pub/Sub)連携の検出(docs/SPEC.md §6.8)。
// コールグラフに現れないメッセージキュー経由の依存を補完する。
// strata.config.json の messaging.publish / messaging.subscribe にメソッド名を指定すると、
//   <recv>.<method>("topic", ...) を検出し、トピックノードと publisher→topic→subscriber の
//   イベント辺(kind:'event')を張る。誤検出を避けるため既定は無効(opt-in)。
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

/** src から <method>(\s*"topic" を拾って topic 名の集合を返す。 */
function findTopics(src: string, methods: string[]): Set<string> {
  const out = new Set<string>();
  if (methods.length === 0) return out;
  const names = methods.map((m) => m.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(`\\.(?:${names})\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) out.add(m[1]);
  return out;
}

export function detectMessaging(ctx: Ctx): void {
  const cfg = ctx.config.messaging;
  if (!cfg || ((cfg.publish?.length ?? 0) === 0 && (cfg.subscribe?.length ?? 0) === 0)) return;
  const publishMethods = cfg.publish ?? [];
  const subscribeMethods = cfg.subscribe ?? [];

  const publishers = new Map<string, Set<string>>(); // topic -> {publisher service id}
  const subscribers = new Map<string, Set<string>>(); // topic -> {subscriber service id}
  const add = (map: Map<string, Set<string>>, topic: string, svc: string): void => {
    let s = map.get(topic);
    if (!s) {
      s = new Set();
      map.set(topic, s);
    }
    s.add(svc);
  };

  for (const project of ctx.projects) {
    if (project.nodeId === '') continue;
    const svc = topAncestorId(ctx, project.nodeId);
    const files = [...project.goFiles, ...project.jsFiles, ...project.exFiles, ...project.pyFiles];
    for (const rel of files) {
      let src: string;
      try {
        src = readFileText(ctx, rel);
      } catch {
        continue;
      }
      for (const t of findTopics(src, publishMethods)) add(publishers, t, svc);
      for (const t of findTopics(src, subscribeMethods)) add(subscribers, t, svc);
    }
  }

  const topics = new Set([...publishers.keys(), ...subscribers.keys()]);
  for (const topic of topics) {
    const topicId = 'topic:' + topic;
    ctx.builder.addNode({ id: topicId, label: topic, kind: 'topic', meta: { line: 1 } });
    for (const pub of publishers.get(topic) ?? []) ctx.builder.addEdge(pub, topicId, 'event', 1);
    for (const sub of subscribers.get(topic) ?? []) ctx.builder.addEdge(topicId, sub, 'event', 1);
  }
}
