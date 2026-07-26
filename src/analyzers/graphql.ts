// GraphQL 解析(docs/SPEC.md §6.10)。
//
// スキーマ(SDL)の Query / Mutation / Subscription フィールドをノード化し、
//   - リゾルバ実装(gqlgen の *queryResolver / Apollo の resolvers オブジェクト)へ impl 辺
//   - クライアントの gql`query { ... }` から field への graphql 辺
//   - federation の @key / extend type によるサブグラフ間参照へ graphql 辺
// を張る。RPC と同じく「候補が一意に決まるときだけ接続する」方針。
//
// 対象:
//   スキーマ  *.graphql / *.gql / *.graphqls、および TS/JS・Go 中の gql`...` インライン SDL
//   実装      Go(gqlgen 生成リゾルバ)、TS/JS(resolvers = { Query: { ... } })
//   呼び出し  TS/JS の gql`query|mutation|subscription`、Go の graphql.NewRequest(`...`)
//
// 無効化: strata.config.json の { "graphql": { "enabled": false } }

import * as path from 'node:path';
import { chainBase, type Ctx } from '../context.ts';
import { countLines, makeLineFinder, matchBrace } from '../lex.ts';
import {
  buildFuncIndex,
  buildShortNameIndex,
  enclosingNodeId,
  readSource,
  topAncestorId,
  type FuncIndex,
} from './endpoints.ts';

const ROOTS: Record<string, 'query' | 'mutation' | 'subscription'> = {
  Query: 'query',
  Mutation: 'mutation',
  Subscription: 'subscription',
};

interface FieldRec {
  id: string;
  root: string; // Query / Mutation / Subscription
  name: string;
  owner: string; // スキーマを持つトップレベル(サービス/モジュール)ノード id
}

/** SDL テキストから `type X { ... }` ブロックを列挙する。 */
function* typeBlocks(
  sdl: string,
): Generator<{ kind: string; name: string; body: string; index: number; bodyStart: number; head: string }> {
  const re = /\b(extend\s+)?(type|interface)\s+(\w+)([^{}]*)\{/g;
  for (let m = re.exec(sdl); m; m = re.exec(sdl)) {
    const open = re.lastIndex - 1;
    const end = matchBrace(sdl, open);
    if (end < 0) continue;
    yield {
      kind: (m[1] ? 'extend ' : '') + m[3],
      name: m[3],
      body: sdl.slice(open + 1, end),
      index: m.index,
      bodyStart: open + 1,
      head: m[0],
    };
    re.lastIndex = end;
  }
}

/** ブロック本文からフィールド(名前・戻り型・行オフセット)を取り出す。 */
function fieldsOf(body: string): Array<{ name: string; type: string; offset: number }> {
  const out: Array<{ name: string; type: string; offset: number }> = [];
  const re = /(^|\n)\s*(\w+)\s*(\([^)]*\))?\s*:\s*([^\n#]+)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) {
    const name = m[2];
    if (name === 'schema') continue;
    out.push({ name, type: m[4].trim().replace(/\s+@.*$/, ''), offset: m.index + m[1].length });
  }
  return out;
}

/** SDL 中の @key(fields: "...") を持つ型(federation のエンティティ)を集める。 */
function entitiesOf(sdl: string): { owned: Record<string, string>; extended: Record<string, string> } {
  const owned: Record<string, string> = {};
  const extended: Record<string, string> = {};
  for (const block of typeBlocks(sdl)) {
    const key = /@key\s*\(\s*fields\s*:\s*"([^"]*)"/.exec(block.head);
    if (!key) continue;
    if (block.kind.startsWith('extend ')) extended[block.name] = key[1];
    else owned[block.name] = key[1];
  }
  return { owned, extended };
}

/** open の位置の括弧に対応する閉じ括弧の位置。見つからなければ -1。 */
function matchParen(src: string, open: number): number {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === '(') depth++;
    else if (src[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** `...Fragment` / `... on Type` を読み飛ばし、最後に読んだ位置を返す。 */
function skipSpread(body: string, start: number): number {
  let i = start;
  while (i < body.length && body[i] === '.') i++;
  const name = /^\s*(\w+)/.exec(body.slice(i));
  if (!name) return i - 1;
  i += name[0].length;
  if (name[1] !== 'on') return i - 1;
  const type = /^\s*\w+/.exec(body.slice(i));
  return (type ? i + type[0].length : i) - 1;
}

/**
 * 選択セットの本文から、最上位の選択フィールド名だけを取り出す。
 * 引数リスト `(...)`・ディレクティブ・コメント・文字列・入れ子の選択セットは読み飛ばす。
 * `alias: field` は field 側を採る(スキーマに存在するのは field のため)。
 * 制限: ルート直下のインラインフラグメント(`... on X { ... }`)の中身は数えない。
 */
function rootFields(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '(') {
      const close = matchParen(body, i);
      if (close < 0) break;
      i = close;
    } else if (ch === '"') {
      // 三重引用符も終端が `"` なので、次の引用符まで飛ばせば足りる
      while (++i < body.length && body[i] !== '"') if (body[i] === '\\') i++;
    } else if (ch === '#') {
      while (i < body.length && body[i] !== '\n') i++;
    } else if (ch === '.') {
      i = skipSpread(body, i);
    } else if (ch === '@' || ch === '$') {
      while (i + 1 < body.length && /\w/.test(body[i + 1])) i++; // ディレクティブ名・変数名
    } else if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < body.length && /\w/.test(body[j])) j++;
      const word = body.slice(i, j);
      i = j - 1;
      // 直後が `:` ならエイリアス。実フィールド名は次の語なので、ここでは出さない
      let k = j;
      while (k < body.length && /\s/.test(body[k])) k++;
      if (body[k] === ':') continue;
      if (depth === 0 && !['on', 'true', 'false', 'null'].includes(word)) out.push(word);
    }
  }
  return out;
}

/** クライアント側の操作テキストから、ルート直下の選択フィールド名を取り出す。 */
function selectionsOf(op: string): Array<{ root: 'query' | 'mutation' | 'subscription'; name: string }> {
  const out: Array<{ root: 'query' | 'mutation' | 'subscription'; name: string }> = [];
  const re = /\b(query|mutation|subscription)\b[^{}]*\{/g;
  for (let m = re.exec(op); m; m = re.exec(op)) {
    const open = re.lastIndex - 1;
    const end = matchBrace(op, open);
    if (end < 0) continue;
    const root = m[1] as 'query' | 'mutation' | 'subscription';
    for (const name of rootFields(op.slice(open + 1, end))) out.push({ root, name });
    re.lastIndex = end;
  }
  return out;
}

/** バッククォート / トリプルクォートの GraphQL ドキュメントを抜き出す。 */
function gqlLiterals(src: string): Array<{ text: string; index: number }> {
  const out: Array<{ text: string; index: number }> = [];
  const re = /\b(?:gql|graphql|GraphQL|NewRequest)\s*(?:\(\s*)?`([^`]*)`/g;
  for (let m = re.exec(src); m; m = re.exec(src)) out.push({ text: m[1], index: m.index });
  return out;
}

export function detectGraphql(ctx: Ctx): void {
  if (ctx.config.graphql?.enabled === false) return;
  const funcIndex: FuncIndex = buildFuncIndex(ctx);
  const fields: FieldRec[] = [];
  const byName = new Map<string, FieldRec[]>(); // "query:users" -> 候補
  const byBareName = new Map<string, FieldRec[]>(); // "users" -> 候補(root 不明な呼び出し用)
  const entityOwner = new Map<string, string>(); // 型名 → 所有サブグラフのスキーマノード id
  const entityUsers: Array<{ type: string; nodeId: string }> = [];

  const addField = (rec: FieldRec): void => {
    fields.push(rec);
    const key = `${ROOTS[rec.root]}:${rec.name.toLowerCase()}`;
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(rec);
    const bare = rec.name.toLowerCase();
    if (!byBareName.has(bare)) byBareName.set(bare, []);
    byBareName.get(bare)!.push(rec);
  };

  /** SDL を読み、Query/Mutation/Subscription のフィールドをノード化する。 */
  const registerSdl = (sdl: string, schemaNodeId: string, file: string, baseLine: number): void => {
    const lineOfSdl = makeLineFinder(sdl);
    for (const block of typeBlocks(sdl)) {
      const root = ROOTS[block.name];
      if (!root) continue;
      for (const f of fieldsOf(block.body)) {
        // SDL 内での絶対オフセット → 行。baseLine はコード中インライン SDL の開始行
        const line = baseLine + lineOfSdl(block.bodyStart + f.offset) - 1;
        const id = `gql:${schemaNodeId}#${block.name}.${f.name}`;
        ctx.builder.addNode({
          id,
          label: `${block.name}.${f.name}`,
          parent: schemaNodeId,
          kind: 'gqlfield',
          lang: 'graphql',
          meta: {
            file,
            line: Math.max(1, line),
            gqlKind: root,
            gqlType: f.type,
          },
        });
        addField({ id, root: block.name, name: f.name, owner: topAncestorId(ctx, schemaNodeId) });
      }
    }
    const ents = entitiesOf(sdl);
    if (Object.keys(ents.owned).length > 0 || Object.keys(ents.extended).length > 0) {
      const node = ctx.builder.get(schemaNodeId);
      if (node) node.meta = { ...node.meta, entities: { ...ents.owned, ...ents.extended } };
      for (const t of Object.keys(ents.owned)) if (!entityOwner.has(t)) entityOwner.set(t, schemaNodeId);
      for (const t of Object.keys(ents.extended)) entityUsers.push({ type: t, nodeId: schemaNodeId });
    }
  };

  // 1) スキーマファイル(.graphql / .gql / .graphqls)
  for (const project of ctx.projects) {
    for (const wsRel of project.gqlFiles ?? []) {
      const src = readSource(ctx, wsRel);
      if (src === undefined) continue;
      const dirname = path.posix.dirname(wsRel);
      const dir = dirname === '.' ? '' : dirname;
      const base = chainBase(ctx, project, dir);
      const parent = ctx.builder.ensureDirChain(dir, base.baseWsRel, base.baseId);
      ctx.builder.addNode({
        id: wsRel,
        label: path.posix.basename(wsRel),
        parent,
        kind: 'file',
        lang: 'graphql',
        loc: countLines(src),
        meta: { file: wsRel, line: 1, subgraph: ctx.builder.get(topAncestorId(ctx, parent))?.label },
      });
      registerSdl(src, wsRel, wsRel, 1);
    }
  }

  // 2) コード中のインライン SDL(Apollo の typeDefs = gql`type Query { ... }`)
  for (const project of ctx.projects) {
    for (const wsRel of [...project.jsFiles, ...project.goFiles]) {
      const src = readSource(ctx, wsRel);
      if (src === undefined) continue;
      if (!src.includes('type Query') && !src.includes('type Mutation') && !src.includes('extend type')) continue;
      const lineOf = makeLineFinder(src);
      for (const lit of gqlLiterals(src)) {
        if (!/\b(type|extend\s+type)\s+\w/.test(lit.text)) continue;
        const owner = enclosingNodeId(ctx, funcIndex, wsRel, lineOf(lit.index));
        const schemaNodeId = ctx.builder.get(wsRel) ? wsRel : owner;
        if (!schemaNodeId) continue;
        registerSdl(lit.text, schemaNodeId, wsRel, lineOf(lit.index));
      }
    }
  }

  if (fields.length === 0 && entityUsers.length === 0) return;

  // 3) リゾルバ実装 → impl 辺
  const funcByLabel = buildShortNameIndex(ctx, true);
  const linkImpl = (rootKind: 'query' | 'mutation' | 'subscription', name: string, funcId: string): void => {
    const cands = byName.get(`${rootKind}:${name.toLowerCase()}`) ?? [];
    if (cands.length === 1) ctx.builder.addEdge(cands[0].id, funcId, 'impl');
  };

  for (const project of ctx.projects) {
    // Go(gqlgen): func (r *queryResolver) Users(ctx context.Context, ...)
    for (const wsRel of project.goFiles) {
      const src = readSource(ctx, wsRel);
      if (src === undefined) continue;
      if (!/Resolver\b/.test(src)) continue;
      const lineOf = makeLineFinder(src);
      const re = /func\s*\(\s*\w+\s+\*?(query|mutation|subscription)Resolver\s*\)\s*(\w+)\s*\(/gi;
      for (let m = re.exec(src); m; m = re.exec(src)) {
        const rootKind = m[1].toLowerCase() as 'query' | 'mutation' | 'subscription';
        const fnId = enclosingNodeId(ctx, funcIndex, wsRel, lineOf(m.index) + 1);
        if (fnId) linkImpl(rootKind, m[2], fnId);
      }
    }
    // TS/JS(Apollo): const resolvers = { Query: { users: ..., }, Mutation: { ... } }
    for (const wsRel of project.jsFiles) {
      const src = readSource(ctx, wsRel);
      if (src === undefined) continue;
      if (!/\b(Query|Mutation|Subscription)\s*:\s*\{/.test(src)) continue;
      const lineOf = makeLineFinder(src);
      const blockRe = /\b(Query|Mutation|Subscription)\s*:\s*\{/g;
      for (let m = blockRe.exec(src); m; m = blockRe.exec(src)) {
        const open = blockRe.lastIndex - 1;
        const end = matchBrace(src, open);
        if (end < 0) continue;
        const body = src.slice(open + 1, end);
        const rootKind = ROOTS[m[1]];
        let depth2 = 0;
        const keyRe = /([A-Za-z_]\w*)\s*(?::|\()|([{}[\]])/g;
        for (let k = keyRe.exec(body); k; k = keyRe.exec(body)) {
          if (k[2] === '{' || k[2] === '[') depth2++;
          else if (k[2] === '}' || k[2] === ']') depth2--;
          else if (depth2 === 0 && k[1]) {
            const fieldName = k[1];
            const fnOffset = open + 1 + k.index;
            const inFn = enclosingNodeId(ctx, funcIndex, wsRel, lineOf(fnOffset));
            const named = funcByLabel.get(fieldName.toLowerCase()) ?? [];
            const target = named.length === 1 ? named[0] : inFn;
            if (target) linkImpl(rootKind, fieldName, target);
          }
        }
        blockRe.lastIndex = end;
      }
    }
  }

  // 4) クライアント操作 → graphql 辺
  for (const project of ctx.projects) {
    for (const wsRel of [...project.jsFiles, ...project.goFiles, ...project.pyFiles]) {
      const src = readSource(ctx, wsRel);
      if (src === undefined) continue;
      if (!/\b(query|mutation|subscription)\b/.test(src)) continue;
      const lineOf = makeLineFinder(src);
      for (const lit of gqlLiterals(src)) {
        if (/\b(type|input|enum)\s+\w+\s*[{@]/.test(lit.text)) continue; // SDL は対象外
        const line = lineOf(lit.index);
        const from = enclosingNodeId(ctx, funcIndex, wsRel, line);
        if (!from) continue;
        for (const sel of selectionsOf(lit.text)) {
          let cands = byName.get(`${sel.root}:${sel.name.toLowerCase()}`) ?? [];
          if (cands.length === 0) cands = byBareName.get(sel.name.toLowerCase()) ?? [];
          if (cands.length !== 1) continue;
          ctx.builder.addEdge(from, cands[0].id, 'graphql', 1, { f: wsRel, l: line });
        }
      }
    }
  }

  // 5) federation: extend type X @key → X を所有するサブグラフへの参照
  for (const user of entityUsers) {
    const owner = entityOwner.get(user.type);
    if (owner && owner !== user.nodeId) ctx.builder.addEdge(user.nodeId, owner, 'graphql');
  }
}
