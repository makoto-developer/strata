// SARIF 2.1.0 出力(docs/SPEC.md §10)。
// 循環依存とアーキテクチャルール違反を GitHub Code Scanning が読める形式で出す。
// `strata check --sarif` で PR に注釈を付けられる。

import type { Graph } from './model.ts';
import type { CycleGroup } from './graph.ts';
import type { RuleViolation } from './rules.ts';

interface SarifLocation {
  physicalLocation: {
    artifactLocation: { uri: string };
    region?: { startLine: number };
  };
}

interface SarifResult {
  ruleId: string;
  level: 'error' | 'warning' | 'note';
  message: { text: string };
  locations: SarifLocation[];
}

/** ノードの定義位置(file:line)を SARIF ロケーションにする。file が無ければ null。 */
const PATH_KINDS = new Set(['file', 'proto', 'package', 'dir', 'module']);
function locationOf(model: Graph, id: string): SarifLocation | null {
  const node = model.nodes.find((n) => n.id === id);
  // meta.file 優先。無ければパス的な id を持つ構造ノードはその id を場所にする
  const file = node?.meta?.file ?? (node && PATH_KINDS.has(node.kind) ? node.id : undefined);
  if (!file) return null;
  const line = node?.meta?.line;
  return {
    physicalLocation: {
      artifactLocation: { uri: file },
      ...(typeof line === 'number' ? { region: { startLine: line } } : {}),
    },
  };
}

const labelOf = (model: Graph, id: string): string => model.nodes.find((n) => n.id === id)?.label ?? id;

export function buildSarif(model: Graph, cycles: CycleGroup[], violations: RuleViolation[]): string {
  const ruleDefs = new Map<string, { id: string; name: string; text: string }>();
  const results: SarifResult[] = [];

  // 循環依存
  if (cycles.length > 0) {
    ruleDefs.set('cycle', { id: 'cycle', name: 'circular-dependency', text: '循環依存を検出' });
  }
  for (const c of cycles) {
    const members = c.members.map((m) => labelOf(model, m)).join(' ⇄ ');
    const loc = locationOf(model, c.members[0]);
    results.push({
      ruleId: 'cycle',
      level: 'warning',
      message: { text: `循環依存: ${members} (${c.edgeCount} edges)` },
      locations: loc ? [loc] : [],
    });
  }

  // アーキテクチャルール違反
  for (const v of violations) {
    const id = v.rule.name ?? `${v.rule.from}->${v.rule.to}`;
    if (!ruleDefs.has(id)) {
      ruleDefs.set(id, { id, name: id, text: v.rule.comment ?? `禁止依存: ${v.rule.from} ↛ ${v.rule.to}` });
    }
    const loc = locationOf(model, v.from);
    results.push({
      ruleId: id,
      level: 'error',
      message: {
        text: `禁止依存 (${id}): ${labelOf(model, v.from)} → ${labelOf(model, v.to)} (${v.kind})`,
      },
      locations: loc ? [loc] : [],
    });
  }

  const sarif = {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0',
    runs: [
      {
        tool: {
          driver: {
            name: 'Strata',
            informationUri: 'https://github.com/makoto-developer/strata',
            rules: [...ruleDefs.values()].map((r) => ({
              id: r.id,
              name: r.name,
              shortDescription: { text: r.text },
            })),
          },
        },
        results,
      },
    ],
  };
  return JSON.stringify(sarif, null, 2);
}
