// アーキテクチャレポート生成(docs/SPEC.md §9.3)。
// サービス間依存図(mermaid)とサービス別サマリを Markdown で出力する。
// README やオンボーディング資料にそのまま貼れる形式。

import type { GEdge, GNode, Graph } from './model.ts';
import { findCycles } from './graph.ts';
import { computeServiceMetrics } from './metrics.ts';

interface TopEdge {
  count: number;
  rpc: number;
  code: number;
}

interface ServiceSummary {
  id: string;
  label: string;
  loc: number;
  rpcTotal: number;
  rpcCalled: number;
  rpcTestOnly: number;
  rpcDead: number;
  deadRpcs: string[];
}

function indexModel(model: Graph) {
  const byId = new Map(model.nodes.map((n) => [n.id, n]));
  const chainCache = new Map<string, string[]>();
  const chain = (id: string): string[] => {
    const cached = chainCache.get(id);
    if (cached) return cached;
    const n = byId.get(id);
    const result =
      n && n.parent !== undefined && byId.has(n.parent) ? [...chain(n.parent), id] : [id];
    chainCache.set(id, result);
    return result;
  };
  const childrenOf = new Map<string, string[]>();
  for (const n of model.nodes) {
    const key = n.parent !== undefined && byId.has(n.parent) ? n.parent : '';
    if (!childrenOf.has(key)) childrenOf.set(key, []);
    childrenOf.get(key)!.push(n.id);
  }
  return { byId, chain, childrenOf };
}

export function buildReport(model: Graph): string {
  const { byId, chain, childrenOf } = indexModel(model);

  // RPC → 実装サービスの帰属(共有 proto/ 構成でもサービス結合が正しく出るように)
  const implTop = new Map<string, string>();
  for (const e of model.edges) {
    if (e.kind !== 'impl') continue;
    if (!implTop.has(e.from)) implTop.set(e.from, chain(e.to)[0]);
  }
  const svcTopOfTarget = (toId: string): string => {
    const node = byId.get(toId);
    if (node?.kind === 'rpc') {
      const t = implTop.get(toId);
      if (t) return t;
    } else if (node?.kind === 'proto') {
      for (const kid of childrenOf.get(toId) ?? []) {
        const t = implTop.get(kid);
        if (t) return t;
      }
    }
    return chain(toId)[0];
  };

  // トップレベル間のエッジ集約
  const topEdges = new Map<string, TopEdge>(); // "from to"
  const rpcCallers = new Map<string, number>();
  // サービス間で実際に呼ばれている API 名(RPC / HTTP ルート / GraphQL フィールド)
  const topRpcNames = new Map<string, Set<string>>(); // "from to" -> RPC ラベル
  for (const e of model.edges) {
    if (e.kind === 'rpc' || e.kind === 'http' || e.kind === 'graphql') {
      rpcCallers.set(e.to, (rpcCallers.get(e.to) ?? 0) + 1);
    }
    if (e.kind === 'impl') continue;
    const tu = chain(e.from)[0];
    const tv = svcTopOfTarget(e.to);
    if (tu === tv) continue;
    const key = tu + ' ' + tv;
    const cur = topEdges.get(key) ?? { count: 0, rpc: 0, code: 0 };
    cur.count += e.count;
    if (e.kind === 'rpc' || e.kind === 'proto' || e.kind === 'http' || e.kind === 'graphql') cur.rpc += e.count;
    else cur.code += e.count;
    topEdges.set(key, cur);
    if (e.kind === 'rpc' || e.kind === 'http' || e.kind === 'graphql') {
      const label = byId.get(e.to)?.label;
      if (label) {
        if (!topRpcNames.has(key)) topRpcNames.set(key, new Set());
        topRpcNames.get(key)!.add(label);
      }
    }
  }

  // サービス別サマリ
  const tops = (childrenOf.get('') ?? []).filter((id) => byId.has(id));
  const subtreeLoc = new Map<string, number>();
  for (const n of model.nodes) {
    const top = chain(n.id)[0];
    subtreeLoc.set(top, (subtreeLoc.get(top) ?? 0) + (n.loc ?? 0));
  }
  const summaries: ServiceSummary[] = tops.map((id) => {
    const label = byId.get(id)?.label ?? id;
    let rpcTotal = 0;
    let rpcCalled = 0;
    let rpcTestOnly = 0;
    const deadRpcs: string[] = [];
    for (const n of model.nodes) {
      if (n.kind !== 'rpc') continue;
      const owner = implTop.get(n.id) ?? chain(n.id)[0];
      if (owner !== id) continue;
      rpcTotal++;
      if ((rpcCallers.get(n.id) ?? 0) > 0) rpcCalled++;
      else if ((n.meta?.testCallers ?? 0) > 0) rpcTestOnly++;
      else deadRpcs.push(n.label);
    }
    return {
      id,
      label,
      loc: subtreeLoc.get(id) ?? 0,
      rpcTotal,
      rpcCalled,
      rpcTestOnly,
      rpcDead: deadRpcs.length,
      deadRpcs,
    };
  });

  // mermaid ノード ID(記号を含まない安全な名前に置換)
  const mermaidId = new Map<string, string>();
  tops.forEach((id, i) => mermaidId.set(id, 's' + i));

  const lines: string[] = [];
  lines.push(`# ${model.name} アーキテクチャレポート`);
  lines.push('');
  lines.push(`> ${model.tool} により生成(${model.createdAt})。`);
  lines.push('> 静的解析のため、メッセージキュー等の動的連携は含まれない。');
  lines.push('');
  lines.push('## サービス間依存図');
  lines.push('');
  lines.push('実線 = gRPC / API 依存、点線 = コード依存(import / call)。数字は依存数。');
  lines.push('');
  lines.push('```mermaid');
  lines.push('graph LR');
  for (const id of tops) {
    lines.push(`  ${mermaidId.get(id)}["${byId.get(id)?.label ?? id}"]`);
  }
  for (const [key, d] of [...topEdges].sort((a, b) => b[1].count - a[1].count)) {
    const [from, to] = key.split(' ');
    const a = mermaidId.get(from);
    const b = mermaidId.get(to);
    if (!a || !b) continue;
    if (d.rpc > 0) lines.push(`  ${a} -->|"${d.rpc}"| ${b}`);
    if (d.code > 0) lines.push(`  ${a} -.->|"${d.code}"| ${b}`);
  }
  lines.push('```');
  lines.push('');

  // 図の数字だけでは「何を呼んでいるか」が分からないため、RPC 名で内訳を出す
  if (topRpcNames.size > 0) {
    lines.push('## サービス間の呼び出し詳細');
    lines.push('');
    lines.push('| 呼び出し元 | 呼び出し先 | 使用している API(RPC / HTTP / GraphQL) |');
    lines.push('|---|---|---|');
    const entries = [...topRpcNames].sort(
      (a, b) => (topEdges.get(b[0])?.rpc ?? 0) - (topEdges.get(a[0])?.rpc ?? 0),
    );
    for (const [key, names] of entries) {
      const [from, to] = key.split(' ');
      const fromLabel = byId.get(from)?.label ?? from;
      const toLabel = byId.get(to)?.label ?? to;
      lines.push(`| ${fromLabel} | ${toLabel} | ${[...names].sort().join(', ')} |`);
    }
    lines.push('');
  }

  lines.push('## サービス別サマリ');
  lines.push('');
  lines.push('| サービス | 規模(LOC) | 公開 API | 本番から呼ばれる | テストのみ | 未使用 |');
  lines.push('|---|---:|---:|---:|---:|---:|');
  for (const s of [...summaries].sort((a, b) => b.loc - a.loc)) {
    lines.push(
      `| ${s.label} | ${s.loc.toLocaleString('en-US')} | ${s.rpcTotal} | ${s.rpcCalled} | ${s.rpcTestOnly} | ${s.rpcDead} |`,
    );
  }
  lines.push('');

  const allDead = summaries.filter((s) => s.deadRpcs.length > 0);
  lines.push('## 未使用の可能性がある API');
  lines.push('');
  if (allDead.length === 0) {
    lines.push('なし 🎉');
  } else {
    lines.push('本番コードからもテストからも呼び出しが見つからない RPC(棚卸し候補):');
    lines.push('');
    for (const s of allDead) {
      lines.push(`- **${s.label}**: ${s.deadRpcs.join(', ')}`);
    }
  }
  lines.push('');

  const cycles = findCycles(model);
  lines.push('## 循環依存');
  lines.push('');
  if (cycles.length === 0) {
    lines.push('なし 🎉');
  } else {
    for (const c of cycles) {
      const where = c.parent === '' ? '(トップレベル)' : c.parent;
      const members = c.members.map((id) => byId.get(id)?.label ?? id).join(' ⇄ ');
      lines.push(`- [${where}] ${members} (${c.edgeCount} edges)`);
    }
  }
  lines.push('');

  // サービス結合度メトリクス
  const metrics = computeServiceMetrics(model);
  if (metrics.length > 0) {
    lines.push('## サービス結合度メトリクス');
    lines.push('');
    lines.push('`Ca`=依存される数 / `Ce`=依存する数 / `I`=不安定度 Ce/(Ca+Ce)。');
    lines.push('I が高いほど変更の影響を受けやすく、低いほど変更の影響範囲が広い。');
    lines.push('');
    lines.push('| サービス | Ca | Ce | I | loc | rpc |');
    lines.push('| --- | ---: | ---: | ---: | ---: | ---: |');
    for (const m of metrics) {
      lines.push(`| ${m.label} | ${m.ca} | ${m.ce} | ${m.instability.toFixed(2)} | ${m.loc} | ${m.rpc} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
