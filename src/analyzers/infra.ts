// IaC(Kubernetes / Helm / Terraform)から「環境変数名 → 実際の値」を読み、
// コード側だけでは決まらないトピック名を逆引きする(docs/reference/config.md の infra)。
//
// 背景: MQ のトピックが os.Getenv("KAFKA_TOPIC") のように環境変数で与えられていると、
// コードからは publish 側と subscribe 側が同じトピックか分からない。デプロイ定義まで読むと繋がる。
//
// 同じ変数名がサービスごとに別の値を持つのが普通なので、値はサービス単位にスコープを分ける。
// 実行時に組み立てられる名前(fmt.Sprintf 等)は解決せず、未解決として明示する。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { addUnresolved, SKIP_DIRS, type Ctx, type InfraSource } from '../context.ts';
import { linkTopics, type TopicSides } from './messaging.ts';
import { matchesAnyGlob } from '../path-glob.ts';

/** 環境変数の値。scope はサービスノード id('' = どのサービスにも紐付かない全体既定)。 */
interface EnvBinding {
  scope: string;
  name: string;
  value: string;
}

/** IaC 上のスコープ名(k8s の metadata.name、Helm のトップレベルキー、Terraform のラベル)。 */
type ScopedValues = Array<{ scopeName: string; name: string; value: string }>;

function collectFiles(rootAbs: string, globs: string[]): string[] {
  const out: string[] = [];
  const visit = (dirAbs: string, rel: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : rel + '/' + entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(path.join(dirAbs, entry.name), childRel);
      } else if (entry.isFile() && matchesAnyGlob(childRel, globs)) {
        out.push(childRel);
      }
    }
  };
  visit(rootAbs, '');
  return out.sort();
}

function unquote(raw: string): string {
  const trimmed = raw.trim().replace(/,$/, '').trim();
  const m = /^(?:"([^"]*)"|'([^']*)')$/.exec(trimmed);
  return m ? (m[1] ?? m[2]) : trimmed;
}

const INDENT = (line: string): number => line.length - line.trimStart().length;

/** 行末コメントを落とす。引用符の中の # は値の一部なので切らない。 */
function stripYamlComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote !== '') {
      if (ch === quote) quote = '';
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

/**
 * YAML(k8s マニフェスト / Helm values)から環境変数を読む。
 * 汎用パーサは持たず、環境変数が現れる 3 つの形だけを見る:
 *   env: の配列(- name: X / value: Y)、env: のマップ(X: Y)、ConfigMap の data:。
 */
function readYamlEnv(src: string): ScopedValues {
  const out: ScopedValues = [];
  const lines = src.split('\n');
  let scopeName = '';
  let block: { kind: 'list' | 'map'; indent: number } | undefined;
  let pendingName = '';
  for (const raw of lines) {
    const line = stripYamlComment(raw);
    if (line.trim() === '') continue;
    const indent = INDENT(line);
    const text = line.trim();
    if (block && indent <= block.indent && !text.startsWith('-')) block = undefined;

    const name = /^name:\s*(\S.*)$/.exec(text);
    if (!block && name && indent <= 4) scopeName = unquote(name[1]);
    if (/^(env|data|variables):\s*$/.test(text)) {
      block = { kind: 'map', indent };
      pendingName = '';
      continue;
    }
    if (!block) continue;

    const item = /^-\s*name:\s*(\S.*)$/.exec(text);
    if (item) {
      block.kind = 'list';
      pendingName = unquote(item[1]);
      continue;
    }
    const value = /^value:\s*(\S.*)$/.exec(text);
    if (block.kind === 'list' && value && pendingName !== '') {
      out.push({ scopeName, name: pendingName, value: unquote(value[1]) });
      pendingName = '';
      continue;
    }
    const pair = /^([A-Za-z_][\w.-]*):\s*(\S.*)$/.exec(text);
    if (block.kind === 'map' && pair) out.push({ scopeName, name: pair[1], value: unquote(pair[2]) });
  }
  return out;
}

/**
 * Terraform(HCL)から環境変数を読む。
 * `variables = { KEY = "value" }` と、隣接する `name = "X"` / `value = "Y"` の組を拾う。
 */
function readTerraformEnv(src: string): ScopedValues {
  const out: ScopedValues = [];
  const noComments = src.replace(/(^|\s)(#|\/\/).*$/gm, '$1');
  let scopeName = '';
  // resource は 2 ラベル、module は 1 ラベル。どちらも最後のラベルを名前として使う
  const resource = /(?:resource|module)\s+"([^"]*)"(?:\s+"([^"]+)")?/g;
  const scopeAt: Array<{ at: number; name: string }> = [];
  for (let m = resource.exec(noComments); m; m = resource.exec(noComments)) {
    scopeAt.push({ at: m.index, name: m[2] ?? m[1] });
  }
  const scopeFor = (index: number): string => {
    let name = '';
    for (const s of scopeAt) {
      if (s.at > index) break;
      name = s.name;
    }
    return name;
  };

  const varsBlock = /variables\s*=\s*\{([^}]*)\}/g;
  for (let m = varsBlock.exec(noComments); m; m = varsBlock.exec(noComments)) {
    scopeName = scopeFor(m.index);
    const pair = /([A-Za-z_]\w*)\s*=\s*("(?:[^"]*)"|'[^']*')/g;
    for (let p = pair.exec(m[1]); p; p = pair.exec(m[1])) {
      out.push({ scopeName, name: p[1], value: unquote(p[2]) });
    }
  }
  const namedPair = /name\s*=\s*"([A-Za-z_]\w*)"\s*,?\s*value\s*=\s*("(?:[^"]*)")/g;
  for (let m = namedPair.exec(noComments); m; m = namedPair.exec(noComments)) {
    out.push({ scopeName: scopeFor(m.index), name: m[1], value: unquote(m[2]) });
  }
  return out;
}

const normalize = (s: string): string => s.toLowerCase().replace(/[_-]/g, '');

/**
 * IaC 上のスコープ名とファイルパスから、対応するサービスノード id を決める。
 * ファイルの位置 → IaC 上の名前 → パス片、の順で当てる。当たらなければ全体既定('')。
 */
function scopeToServiceId(ctx: Ctx, scopeName: string, wsRel: string): string {
  const services = ctx.config.services ?? [];
  for (const svc of services) {
    const p = svc.path.replace(/\/+$/, '');
    if (wsRel === p || wsRel.startsWith(p + '/')) return 'svc:' + svc.name;
  }
  // 前方一致にすると order-worker が order に化けるので、正規化後の完全一致だけを採る
  const candidates = [scopeName, ...wsRel.split('/').slice(0, -1)].filter((c) => c !== '');
  for (const candidate of candidates) {
    const normalized = normalize(candidate);
    for (const svc of services) {
      if (normalized !== normalize(svc.name)) continue;
      if (ctx.builder.get('svc:' + svc.name)) return 'svc:' + svc.name;
    }
  }
  return '';
}

/** 設定された IaC ソースを読み、サービス単位にスコープ分けした環境変数表を返す。 */
function readInfraEnv(ctx: Ctx, sources: InfraSource[]): EnvBinding[] {
  const out: EnvBinding[] = [];
  for (const source of sources) {
    for (const wsRel of collectFiles(ctx.rootAbs, [source.path])) {
      let src: string;
      try {
        src = fs.readFileSync(path.join(ctx.rootAbs, wsRel), 'utf8');
      } catch {
        continue;
      }
      const values = source.type === 'terraform' ? readTerraformEnv(src) : readYamlEnv(src);
      for (const v of values) {
        out.push({ scope: scopeToServiceId(ctx, v.scopeName, wsRel), name: v.name, value: v.value });
      }
    }
  }
  return out;
}

/**
 * サービス優先で環境変数の値を引く。
 * フォールバックは「どのサービスにも紐付かない全体既定」だけ — 別サービスの値を流用すると、
 * 設定を持たないサービスまで他人のトピックに繋がってしまう。
 */
function lookupEnv(bindings: EnvBinding[], service: string, name: string): string | undefined {
  const scoped = bindings.filter((b) => b.scope === service && b.name === name);
  if (scoped.length > 0) return scoped[0].value;
  const values = new Set(bindings.filter((b) => b.scope === '' && b.name === name).map((b) => b.value));
  return values.size === 1 ? [...values][0] : undefined;
}

/**
 * 環境変数経由 / 動的生成のトピックを解決する。
 * infra が無効でも、動的生成のものは「解決できない理由」として必ず残す。
 */
export function resolveInfraTopics(ctx: Ctx): void {
  if (ctx.pendingTopics.length === 0) return;
  const infra = ctx.config.infra;
  const bindings = infra?.enabled ? readInfraEnv(ctx, infra.sources ?? []) : [];
  const publishers: TopicSides = new Map();
  const subscribers: TopicSides = new Map();
  let resolved = 0;

  for (const pending of ctx.pendingTopics) {
    if (pending.envVar === undefined) {
      addUnresolved(ctx, {
        reason: 'dynamic',
        from: pending.from,
        detail: pending.expr ?? '(不明な式)',
        file: pending.file,
        line: pending.line,
        hint: 'トピック名が実行時に組み立てられているため、静的には決まりません',
      });
      continue;
    }
    const value = lookupEnv(bindings, pending.from, pending.envVar);
    if (value === undefined) {
      addUnresolved(ctx, {
        reason: 'env',
        from: pending.from,
        detail: pending.envVar,
        file: pending.file,
        line: pending.line,
        hint: infra?.enabled
          ? `${pending.envVar} の値が IaC から見つかりません(サービスごとに値が違う場合はスコープも確認してください)`
          : `${pending.envVar} の値はコードからは決まりません。infra の sources に k8s / Helm / Terraform を設定してください`,
      });
      continue;
    }
    const target = pending.role === 'publish' ? publishers : subscribers;
    const set = target.get(value) ?? new Set<string>();
    set.add(pending.from);
    target.set(value, set);
    resolved++;
  }

  linkTopics(ctx, publishers, subscribers);
  if (resolved > 0) {
    ctx.builder.warn(`環境変数経由のトピック名を IaC から ${resolved} 件解決しました`);
  }
}

// テスト用に個別関数も公開
export { readYamlEnv, readTerraformEnv, lookupEnv };
