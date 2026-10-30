// Kubernetes マニフェストからサービスの「ネットワーク上の名前」を読み、
// コード中のホスト名(http://user-api/... )をワークスペースのサービスに結び付ける。
//
// これが無いと、社内ホストへの呼び出しは「ドットを含まない = 社内らしい」までしか分からず、
// どのサービス宛てかはパスの一致に頼るしかない。パスは別サービスでも普通に重なるので、
// 嘘の依存が出る余地が残る。デプロイ定義まで読むと宛先が名前で決まる。
//
// 汎用の YAML パーサは持たない(ゼロ依存のため)。読むのは apiVersion / kind /
// metadata.name / metadata.namespace / 最初の image / replicas だけ。
// テンプレート変数({{ .Values.x }})が入った名前は推測せず捨てる。

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Ctx, Project } from '../context.ts';

/** k8s の 1 リソース。 */
export interface K8sResource {
  kind: string;
  name: string;
  namespace?: string;
  image?: string;
  replicas?: number;
}

const WORKLOAD_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'CronJob', 'Job', 'Rollout']);

/** 名前の比較用。ハイフン・アンダースコアの揺れと大小文字を吸収する。 */
export function normalizeName(v: string): string {
  return v.toLowerCase().replace(/[_-]/g, '');
}

const unquote = (raw: string): string => {
  const s = raw.trim().replace(/\s+#.*$/, '').trim();
  const m = /^(?:"([^"]*)"|'([^']*)')$/.exec(s);
  return m ? (m[1] ?? m[2]) : s;
};

/** テンプレート変数を含む名前は当てにならない(Helm の描画前など)。 */
const isTemplated = (v: string): boolean => v.includes('{{') || v.includes('${');

/**
 * マニフェストを読む。`---` で区切られた複数リソースに対応する。
 * ネストの深さは見ず、行の字面で拾う: metadata.name と spec.template.metadata.name の
 * 取り違えを避けるため、name はインデントが最も浅いものだけを採る。
 */
export function parseK8s(text: string): K8sResource[] {
  const out: K8sResource[] = [];
  for (const doc of text.split(/^(?:---|\.\.\.)\s*$/m)) {
    if (doc.trim() === '') continue;
    let kind: string | undefined;
    let name: string | undefined;
    let nameIndent = Infinity;
    let namespace: string | undefined;
    let image: string | undefined;
    let replicas: number | undefined;
    let inMetadata = false;
    let metadataIndent = 0;
    for (const line of doc.split('\n')) {
      if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
      const indent = line.length - line.trimStart().length;
      const kv = /^\s*"?([\w.\/-]+)"?\s*:(?:\s+(.*))?$/.exec(line);
      if (!kv) continue;
      const key = kv[1];
      const value = unquote(kv[2] ?? '');
      if (indent === 0 && key === 'kind' && value !== '') kind = value;
      if (indent === 0 && key === 'metadata') {
        inMetadata = true;
        metadataIndent = indent;
        continue;
      }
      if (inMetadata && indent <= metadataIndent) inMetadata = false;
      // metadata の直下の name だけを採る。spec.template.metadata.name は別物
      if (inMetadata && key === 'name' && value !== '' && indent < nameIndent) {
        name = value;
        nameIndent = indent;
      }
      if (inMetadata && key === 'namespace' && value !== '') namespace = value;
      if (key === 'image' && value !== '' && image === undefined) image = value;
      if (key === 'replicas' && /^\d+$/.test(value) && replicas === undefined) replicas = Number(value);
    }
    if (kind === undefined || name === undefined || isTemplated(name)) continue;
    out.push({
      kind,
      name,
      ...(namespace && !isTemplated(namespace) ? { namespace } : {}),
      ...(image && !isTemplated(image) ? { image } : {}),
      ...(replicas !== undefined ? { replicas } : {}),
    });
  }
  return out;
}

/**
 * ホスト名 → サービスノード id の索引を作り、対応が付いたサービスに
 * デプロイ情報を書き込む。detectHttp より先に呼ぶ。
 */
export function registerDeploy(ctx: Ctx, projects: Project[]): void {
  if (ctx.config.deploy?.enabled === false) return;

  // 候補サービス: 図の最上位に立つノード(設定の services / リポジトリ / モジュール)
  const topServices = new Map<string, string>(); // 正規化名 -> ノード id
  const ambiguous = new Set<string>(); // 同じ正規化名の最上位ノードが複数 = 宛先を決められない
  for (const n of ctx.builder.nodes.values()) {
    if (n.parent) continue;
    if (n.kind !== 'service' && n.kind !== 'module' && n.kind !== 'dir') continue;
    const key = normalizeName(n.label);
    if (topServices.has(key)) ambiguous.add(key);
    else topServices.set(key, n.id);
  }

  const seen = new Map<string, K8sResource[]>(); // サービスノード id -> そのサービスのリソース
  const unmatched: string[] = [];
  for (const project of projects) {
    for (const wsRel of project.k8sFiles) {
      let text: string;
      try {
        text = fs.readFileSync(path.join(ctx.rootAbs, wsRel), 'utf8');
      } catch {
        continue;
      }
      for (const res of parseK8s(text)) {
        const isService = res.kind === 'Service';
        if (!isService && !WORKLOAD_KINDS.has(res.kind)) continue;
        // 対応先は「マニフェストの置き場所」より「名前」を優先する。
        // 中央の infra リポジトリに全サービスのマニフェストが集まる構成が普通のため
        const key = normalizeName(res.name);
        const svcId = ambiguous.has(key) ? undefined : topServices.get(key);
        if (svcId === undefined) {
          // redis や postgres のような、コードを持たない依存先。
          // クラスタ内であることは分かるのでホスト索引には載せる(宛先は決めない)
          if (isService) ctx.deployHosts.set(key, '');
          if (!ambiguous.has(key)) unmatched.push(res.name);
          continue;
        }
        if (isService) {
          for (const alias of hostAliases(res)) ctx.deployHosts.set(alias, svcId);
        }
        const list = seen.get(svcId) ?? [];
        list.push(res);
        seen.set(svcId, list);
      }
    }
  }

  for (const [svcId, resources] of seen) {
    const workloads = resources.filter((r) => WORKLOAD_KINDS.has(r.kind));
    const svc = resources.find((r) => r.kind === 'Service');
    ctx.builder.addNode({
      id: svcId,
      label: ctx.builder.get(svcId)?.label ?? svcId,
      kind: ctx.builder.get(svcId)?.kind ?? 'service',
      meta: {
        deploy: {
          ...(svc ? { service: svc.name } : {}),
          ...(svc?.namespace ? { namespace: svc.namespace } : {}),
          ...(workloads.length > 0 ? { workloads: workloads.map((w) => `${w.kind}/${w.name}`) } : {}),
          ...(workloads.find((w) => w.image) ? { image: workloads.find((w) => w.image)!.image } : {}),
          ...(workloads.find((w) => w.replicas !== undefined)
            ? { replicas: workloads.find((w) => w.replicas !== undefined)!.replicas }
            : {}),
        },
      },
    });
  }

  if (unmatched.length > 0) {
    const uniq = [...new Set(unmatched)].sort();
    ctx.builder.warn(
      `デプロイ定義にあるがワークスペースに対応するコードが無い: ${uniq.length} 件 — ` +
        uniq.slice(0, 5).join(', ') +
        (uniq.length > 5 ? ` ほか ${uniq.length - 5} 件` : '') +
        '(ミドルウェアや別リポジトリのサービスなら想定どおりです)',
    );
  }
}

/** クラスタ内でそのサービスに届くホスト表記。 */
function hostAliases(res: K8sResource): string[] {
  const base = normalizeName(res.name);
  if (!res.namespace) return [base];
  // user-api.prod / user-api.prod.svc.cluster.local も同じ宛先
  return [base, normalizeName(`${res.name}.${res.namespace}`)];
}
