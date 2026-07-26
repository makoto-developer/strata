// アーキテクチャメトリクス(docs/SPEC.md §11)。
// トップレベル(サービス/モジュール)単位の結合度を算出する。
//   Ca(afferent)= このサービスに依存してくるサービス数(fan-in)
//   Ce(efferent)= このサービスが依存するサービス数(fan-out)
//   I(instability)= Ce/(Ca+Ce)  0=安定(多くに依存される)〜 1=不安定(多くに依存する)
// RPC 依存は「実装しているサービス」に帰属させるので、共有 proto/ 構成でも正しく出る。

import type { Graph } from './model.ts';

export interface ServiceMetric {
  id: string;
  label: string;
  ca: number; // afferent(依存される数)
  ce: number; // efferent(依存する数)
  instability: number; // Ce/(Ca+Ce)
  loc: number;
  rpc: number;
  dependsOn: string[]; // 依存先サービス label(昇順)
  dependedBy: string[]; // 依存元サービス label(昇順)
}

export function computeServiceMetrics(model: Graph): ServiceMetric[] {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const parentOf = new Map(model.nodes.map((n) => [n.id, n.parent]));
  const topCache = new Map<string, string>();
  const topOf = (id: string): string => {
    const hit = topCache.get(id);
    if (hit) return hit;
    let cur = id;
    let guard = 0;
    while (guard++ < 200) {
      const p = parentOf.get(cur);
      if (p === undefined || p === '' || !byId.has(p)) break;
      cur = p;
    }
    topCache.set(id, cur);
    return cur;
  };

  // RPC の実装先(impl エッジ: rpc → 実装関数)。RPC 依存を実装サービスへ帰属させる。
  const implFuncOf = new Map<string, string>();
  for (const e of model.edges) {
    if (e.kind === 'impl') implFuncOf.set(e.from, e.to);
  }
  const targetTop = (id: string): string => {
    const impl = implFuncOf.get(id);
    return topOf(impl ?? id);
  };

  // トップレベルの集合(ルート)
  const roots = model.nodes.filter((n) => !n.parent || !byId.has(n.parent)).map((n) => n.id);
  const dependsOn = new Map<string, Set<string>>(); // s -> {依存先 top}
  const dependedBy = new Map<string, Set<string>>(); // s -> {依存元 top}
  for (const r of roots) {
    dependsOn.set(r, new Set());
    dependedBy.set(r, new Set());
  }

  for (const e of model.edges) {
    if (e.kind === 'impl') continue;
    const tu = topOf(e.from);
    const tv = targetTop(e.to);
    if (tu === tv || !dependsOn.has(tu) || !dependsOn.has(tv)) continue;
    dependsOn.get(tu)!.add(tv);
    dependedBy.get(tv)!.add(tu);
  }

  // loc / rpc をサブツリー集計
  const locOf = new Map<string, number>();
  const rpcOf = new Map<string, number>();
  for (const r of roots) {
    locOf.set(r, 0);
    rpcOf.set(r, 0);
  }
  for (const n of model.nodes) {
    const t = topOf(n.id);
    if (!locOf.has(t)) continue;
    // loc は addLoc/addNode で各ノードに直接載る(祖先集約なし)ので全ノードを合算してよい
    if (typeof n.loc === 'number') locOf.set(t, locOf.get(t)! + n.loc);
    // 公開 API 面(gRPC の RPC / HTTP ルート / GraphQL フィールド)を 1 本の指標にまとめる
    if (n.kind === 'rpc' || n.kind === 'gqlfield' || (n.kind === 'route' && !n.meta?.external)) {
      rpcOf.set(t, rpcOf.get(t)! + 1);
    }
  }

  const labelOf = (id: string) => byId.get(id)?.label ?? id;
  const out: ServiceMetric[] = roots.map((id) => {
    const ce = dependsOn.get(id)!.size;
    const ca = dependedBy.get(id)!.size;
    const instability = ca + ce === 0 ? 0 : ce / (ca + ce);
    return {
      id,
      label: labelOf(id),
      ca,
      ce,
      instability,
      loc: locOf.get(id) ?? 0,
      rpc: rpcOf.get(id) ?? 0,
      dependsOn: [...dependsOn.get(id)!].map(labelOf).sort(),
      dependedBy: [...dependedBy.get(id)!].map(labelOf).sort(),
    };
  });
  // 結合の大きい順 → 名前順
  out.sort((a, b) => b.ca + b.ce - (a.ca + a.ce) || a.label.localeCompare(b.label));
  return out;
}
