// グラフアルゴリズム: Tarjan SCC・兄弟レベル循環検出・コールツリー(docs/SPEC.md §8.2, §9)

import type { Graph, GNode, GEdge, EdgeKind } from './model.ts';

/** 反復版 Tarjan。ids 内のノードと adj(ids 内への隣接)から強連結成分を返す。 */
export function tarjanSCC(ids: string[], adj: Map<string, string[]>): string[][] {
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: string[][] = [];
  let counter = 0;

  for (const start of ids) {
    if (index.has(start)) continue;
    // 明示スタックで DFS(深い再帰を避ける)
    const work: Array<{ node: string; childIndex: number }> = [{ node: start, childIndex: 0 }];
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const node = frame.node;
      if (frame.childIndex === 0) {
        index.set(node, counter);
        low.set(node, counter);
        counter++;
        stack.push(node);
        onStack.add(node);
      }
      const neighbors = adj.get(node) ?? [];
      let advanced = false;
      while (frame.childIndex < neighbors.length) {
        const next = neighbors[frame.childIndex];
        frame.childIndex++;
        if (!index.has(next)) {
          work.push({ node: next, childIndex: 0 });
          advanced = true;
          break;
        } else if (onStack.has(next)) {
          low.set(node, Math.min(low.get(node)!, index.get(next)!));
        }
      }
      if (advanced) continue;
      if (frame.childIndex >= neighbors.length) {
        if (low.get(node) === index.get(node)) {
          const comp: string[] = [];
          while (true) {
            const popped = stack.pop()!;
            onStack.delete(popped);
            comp.push(popped);
            if (popped === node) break;
          }
          result.push(comp);
        }
        work.pop();
        const parentFrame = work[work.length - 1];
        if (parentFrame) {
          low.set(parentFrame.node, Math.min(low.get(parentFrame.node)!, low.get(node)!));
        }
      }
    }
  }
  return result;
}

/** ルートから各ノードへの祖先チェーン(root→...→node)を返すユーティリティ。 */
export function buildChains(nodes: GNode[]): Map<string, string[]> {
  const parentOf = new Map<string, string | undefined>();
  for (const n of nodes) parentOf.set(n.id, n.parent);
  const chains = new Map<string, string[]>();
  const resolve = (id: string): string[] => {
    const cached = chains.get(id);
    if (cached) return cached;
    const parent = parentOf.get(id);
    const chain = parent !== undefined && parentOf.has(parent) ? [...resolve(parent), id] : [id];
    chains.set(id, chain);
    return chain;
  };
  for (const n of nodes) resolve(n.id);
  return chains;
}

export interface SiblingEdge {
  from: string;
  to: string;
  count: number;
  kinds: Set<EdgeKind>;
}

/**
 * 生エッジを「親ごとの兄弟間エッジ」に集約する。
 * 返り値: 親ID('' = ルート集合) → (from + ' ' + to → SiblingEdge)
 */
export function siblingEdges(graph: Graph, chains: Map<string, string[]>): Map<string, Map<string, SiblingEdge>> {
  const out = new Map<string, Map<string, SiblingEdge>>();
  for (const e of graph.edges) {
    // impl(RPC → 実装)はコールグラフ専用。構造上の依存としては扱わない
    if (e.kind === 'impl') continue;
    const cu = chains.get(e.from);
    const cv = chains.get(e.to);
    if (!cu || !cv) continue;
    let i = 0;
    while (i < cu.length && i < cv.length && cu[i] === cv[i]) i++;
    if (i >= cu.length || i >= cv.length) continue; // 祖先-子孫関係
    const parentKey = i === 0 ? '' : cu[i - 1];
    const a = cu[i];
    const b = cv[i];
    let bucket = out.get(parentKey);
    if (!bucket) {
      bucket = new Map();
      out.set(parentKey, bucket);
    }
    const key = a + ' ' + b;
    const existing = bucket.get(key);
    if (existing) {
      existing.count += e.count;
      existing.kinds.add(e.kind);
    } else {
      bucket.set(key, { from: a, to: b, count: e.count, kinds: new Set([e.kind]) });
    }
  }
  return out;
}

export interface CycleGroup {
  parent: string; // '' = ルート
  members: string[];
  edgeCount: number;
}

/** 全親グループの兄弟レベルで循環(SCC サイズ > 1)を検出する。 */
export function findCycles(graph: Graph): CycleGroup[] {
  const chains = buildChains(graph.nodes);
  const sib = siblingEdges(graph, chains);
  const childrenOf = new Map<string, string[]>();
  for (const n of graph.nodes) {
    const key = n.parent ?? '';
    let list = childrenOf.get(key);
    if (!list) {
      list = [];
      childrenOf.set(key, list);
    }
    list.push(n.id);
  }
  const cycles: CycleGroup[] = [];
  for (const [parentKey, bucket] of sib) {
    const kids = childrenOf.get(parentKey) ?? [];
    const adj = new Map<string, string[]>();
    for (const edge of bucket.values()) {
      let list = adj.get(edge.from);
      if (!list) {
        list = [];
        adj.set(edge.from, list);
      }
      list.push(edge.to);
    }
    for (const comp of tarjanSCC(kids, adj)) {
      if (comp.length < 2) continue;
      const memberSet = new Set(comp);
      let edgeCount = 0;
      for (const edge of bucket.values()) {
        if (memberSet.has(edge.from) && memberSet.has(edge.to)) edgeCount += edge.count;
      }
      cycles.push({ parent: parentKey, members: comp.sort(), edgeCount });
    }
  }
  cycles.sort((a, b) => (a.parent < b.parent ? -1 : a.parent > b.parent ? 1 : 0));
  return cycles;
}

// ---- トレース(コールツリー) ----

export interface TraceNode {
  id: string;
  edgeKind?: EdgeKind; // 親からこのノードへ辿ったエッジ種別
  cycle: boolean; // 経路上に既出(循環で打ち切り)
  children: TraceNode[];
}

const CALL_KINDS: EdgeKind[] = ['call', 'rpc', 'impl'];

/** focus から下流(up=false)/上流(up=true)へ call/rpc/impl エッジを辿ったツリーを作る。 */
export function trace(graph: Graph, focusId: string, up: boolean, maxDepth = 12): TraceNode {
  const adj = new Map<string, Array<{ to: string; kind: EdgeKind }>>();
  for (const e of graph.edges) {
    if (!CALL_KINDS.includes(e.kind)) continue;
    const from = up ? e.to : e.from;
    const to = up ? e.from : e.to;
    let list = adj.get(from);
    if (!list) {
      list = [];
      adj.set(from, list);
    }
    list.push({ to, kind: e.kind });
  }
  for (const list of adj.values()) list.sort((a, b) => (a.to < b.to ? -1 : 1));

  const build = (id: string, path: Set<string>, depth: number, edgeKind?: EdgeKind): TraceNode => {
    if (path.has(id)) return { id, edgeKind, cycle: true, children: [] };
    if (depth > maxDepth) return { id, edgeKind, cycle: false, children: [] };
    path.add(id);
    const children = (adj.get(id) ?? []).map((n) => build(n.to, path, depth + 1, n.kind));
    path.delete(id);
    return { id, edgeKind, cycle: false, children };
  };
  return build(focusId, new Set(), 0);
}
