// Protocol Buffers 解析(docs/SPEC.md §5.4, §6.4)
// service/rpc をノード化し、go_package・RPC 名の索引を作って Go/TS 解析器に提供する。

import * as fs from 'node:fs';
import * as path from 'node:path';
import { chainBase, readFileText, type Ctx, type Project, type RpcInfo } from '../context.ts';
import { countLines, leadingComment, makeLineFinder, matchBrace, stripSource } from '../lex.ts';

export interface ProtoState {
  project: Project;
  files: Array<{ id: string; imports: string[] }>;
}

function lowerCamel(name: string): string {
  return name.length === 0 ? name : name[0].toLowerCase() + name.slice(1);
}

export function registerProto(ctx: Ctx, project: Project): ProtoState {
  const state: ProtoState = { project, files: [] };
  for (const wsRel of project.protoFiles) {
    const src = readFileText(ctx, wsRel);
    const { noComments, blanked } = stripSource(src, 'go');
    const lineOf = makeLineFinder(src);
    const srcLines = src.split('\n');
    const dirname = path.posix.dirname(wsRel);
    const dir = dirname === '.' ? '' : dirname;
    const base = chainBase(ctx, project, dir);
    const parent = ctx.builder.ensureDirChain(dir, base.baseWsRel, base.baseId);

    const pkgMatch = noComments.match(/^\s*package\s+([\w.]+)\s*;/m);
    const goPkgMatch = noComments.match(/option\s+go_package\s*=\s*"([^"]+)"/);
    const goPackage = goPkgMatch ? goPkgMatch[1].split(';')[0] : undefined;

    const serviceNames: string[] = [];
    const rpcMap = new Map<string, RpcInfo>();
    const svcRe = /\bservice\s+(\w+)\s*\{/g;
    let svcMatch: RegExpExecArray | null;
    while ((svcMatch = svcRe.exec(blanked)) !== null) {
      const serviceName = svcMatch[1];
      serviceNames.push(serviceName);
      const openIndex = svcRe.lastIndex - 1;
      const closeIndex = matchBrace(blanked, openIndex);
      if (closeIndex < 0) continue;
      const body = blanked.slice(openIndex, closeIndex);
      // シグネチャ全体を取り、stream 種別とリクエスト/レスポンス型も抽出する
      const rpcRe = /\brpc\s+(\w+)\s*\(\s*(stream\s+)?([\w.]+)\s*\)\s*returns\s*\(\s*(stream\s+)?([\w.]+)\s*\)/g;
      const rpcDecls: RegExpExecArray[] = [];
      let rpcMatch: RegExpExecArray | null;
      while ((rpcMatch = rpcRe.exec(body)) !== null) rpcDecls.push(rpcMatch);
      for (let ri = 0; ri < rpcDecls.length; ri++) {
        const decl = rpcDecls[ri];
        const rpcName = decl[1];
        const rpcId = `${wsRel}#${serviceName}.${rpcName}`;
        const line = lineOf(openIndex + decl.index);
        // この rpc 宣言から次の rpc までの区間に option deprecated があるか
        const segmentEnd = ri + 1 < rpcDecls.length ? rpcDecls[ri + 1].index : body.length;
        const deprecated = /\boption\s+deprecated\s*=\s*true/.test(body.slice(decl.index, segmentEnd));
        const sIn = decl[2] !== undefined;
        const sOut = decl[4] !== undefined;
        const streaming = sIn && sOut ? 'bidi' : sIn ? 'client' : sOut ? 'server' : undefined;
        const doc = leadingComment(srcLines, line);
        ctx.builder.addNode({
          id: rpcId,
          label: `${serviceName}.${rpcName}`,
          parent: wsRel,
          kind: 'rpc',
          lang: 'proto',
          meta: {
            file: wsRel,
            line,
            req: decl[3],
            res: decl[5],
            ...(deprecated ? { deprecated: true } : {}),
            ...(streaming ? { streaming } : {}),
            ...(doc ? { doc } : {}),
          },
        });
        const info: RpcInfo = { rpcId, protoId: wsRel, service: serviceName, name: rpcName };
        rpcMap.set(rpcName, info);
        for (const key of new Set([rpcName, lowerCamel(rpcName)])) {
          let list = ctx.rpcByName.get(key);
          if (!list) {
            list = [];
            ctx.rpcByName.set(key, list);
          }
          list.push(info);
        }
        {
          // 頭字語の表記ゆれ(ConfirmCODPayment vs ConfirmCodPayment)救済用の小文字索引
          const lower = rpcName.toLowerCase();
          let list = ctx.rpcByNameLower.get(lower);
          if (!list) {
            list = [];
            ctx.rpcByNameLower.set(lower, list);
          }
          list.push(info);
        }
      }
    }

    // message / enum の定義位置(ビューアの ⌘クリック定義ジャンプ用)
    const messages: Record<string, number> = {};
    const msgRe = /\b(?:message|enum)\s+(\w+)\s*\{/g;
    let msgMatch: RegExpExecArray | null;
    while ((msgMatch = msgRe.exec(blanked)) !== null) {
      if (messages[msgMatch[1]] === undefined) messages[msgMatch[1]] = lineOf(msgMatch.index);
    }

    // ファイル冒頭の説明文(syntax 行の直上コメント)
    const syntaxMatch = blanked.match(/^\s*syntax\s*=/m);
    const fileDoc = syntaxMatch ? leadingComment(srcLines, lineOf(syntaxMatch.index ?? 0)) : undefined;

    ctx.builder.addNode({
      id: wsRel,
      label: path.posix.basename(wsRel),
      parent,
      kind: 'proto',
      lang: 'proto',
      loc: countLines(src),
      meta: {
        ...(pkgMatch ? { pkg: pkgMatch[1] } : {}),
        ...(serviceNames.length > 0 ? { services: serviceNames } : {}),
        ...(goPackage ? { goPackage } : {}),
        ...(Object.keys(messages).length > 0 ? { messages } : {}),
        ...(fileDoc ? { doc: fileDoc } : {}),
        file: wsRel,
        line: 1,
      },
    });

    if (goPackage) ctx.protoGoPackage.set(goPackage, wsRel);
    if (pkgMatch) {
      // proto パッケージ名由来のサフィックス(go_package と import パスが食い違う場合の救済)
      const suffix = pkgMatch[1].replace(/\./g, '/');
      const existing = ctx.protoGoPackageSuffix.get(suffix);
      if (existing === undefined) ctx.protoGoPackageSuffix.set(suffix, wsRel);
      else if (existing !== wsRel) ctx.protoGoPackageSuffix.set(suffix, null);
    }
    if (rpcMap.size > 0) ctx.rpcOfProto.set(wsRel, rpcMap);
    ctx.protoFiles.push({ id: wsRel, wsRel });
    const baseName = path.posix.basename(wsRel, '.proto');
    let byBase = ctx.protoByBase.get(baseName);
    if (!byBase) {
      byBase = [];
      ctx.protoByBase.set(baseName, byBase);
    }
    byBase.push(wsRel);

    const imports: string[] = [];
    const importRe = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm;
    let importMatch: RegExpExecArray | null;
    while ((importMatch = importRe.exec(noComments)) !== null) imports.push(importMatch[1]);
    state.files.push({ id: wsRel, imports });
    for (const s of serviceNames) ctx.protoServiceNames.add(s);
  }

  return state;
}

/**
 * .proto ソースが無く生成済み *_grpc.pb.go だけがある場合、
 * そこから service / RPC 定義を復元して proto 相当のノードを作る(実リポジトリ対応)。
 *
 * 実 proto で定義済みの service は重複登録しない(重複すると RPC 名が曖昧になり
 * 接続がスキップされる)。この判定は ctx.protoServiceNames に依存するため、
 * 全プロジェクトの実 proto を登録し終えた後に呼ぶこと(プロジェクト走査順に依存しない)。
 */
export function registerGeneratedStubs(ctx: Ctx, project: Project): void {
  if (project.genGrpcFiles.length === 0) return;

  let modPath: string | undefined;
  if (project.hasGo) {
    try {
      const goMod = fs.readFileSync(path.join(ctx.rootAbs, project.rootRel, 'go.mod'), 'utf8');
      modPath = goMod.match(/^module\s+(\S+)/m)?.[1];
    } catch {
      // 続行
    }
  }

  for (const wsRel of project.genGrpcFiles) {
    const src = readFileText(ctx, wsRel);
    const lineOf = makeLineFinder(src);

    // service ごとの RPC を収集: FullMethodName 定数(新形式)か ServiceDesc(旧形式)
    const services = new Map<string, Array<{ name: string; index: number }>>();
    let protoPkg = '';
    const fullRe = /FullMethodName\s*=\s*"\/([\w.]+)\/(\w+)"/g;
    let m: RegExpExecArray | null;
    while ((m = fullRe.exec(src)) !== null) {
      const full = m[1];
      const service = full.split('.').pop()!;
      protoPkg = full.slice(0, full.length - service.length - 1);
      let list = services.get(service);
      if (!list) {
        list = [];
        services.set(service, list);
      }
      list.push({ name: m[2], index: m.index });
    }
    if (services.size === 0) {
      const svcMatch = src.match(/ServiceName:\s*"([\w.]+)"/);
      if (svcMatch) {
        const full = svcMatch[1];
        const service = full.split('.').pop()!;
        protoPkg = full.slice(0, full.length - service.length - 1);
        const list: Array<{ name: string; index: number }> = [];
        const methodRe = /MethodName:\s*"(\w+)"/g;
        while ((m = methodRe.exec(src)) !== null) list.push({ name: m[1], index: m.index });
        services.set(service, list);
      }
    }
    // 実 proto で定義済みの service は生成コードから重複登録しない
    for (const name of services.keys()) {
      if (ctx.protoServiceNames.has(name)) services.delete(name);
    }
    if (services.size === 0) continue;

    const dirname = path.posix.dirname(wsRel);
    const dir = dirname === '.' ? '' : dirname;
    const base = chainBase(ctx, project, dir);
    const parent = ctx.builder.ensureDirChain(dir, base.baseWsRel, base.baseId);
    const label = path.posix.basename(wsRel).replace(/_grpc\.pb\.go$/, '.proto');
    ctx.builder.addNode({
      id: wsRel,
      label: `${label} (生成コードから復元)`,
      parent,
      kind: 'proto',
      lang: 'proto',
      meta: {
        ...(protoPkg ? { pkg: protoPkg } : {}),
        services: [...services.keys()],
        generated: true,
        file: wsRel,
        line: 1,
      },
    });

    const rpcMap = ctx.rpcOfProto.get(wsRel) ?? new Map<string, RpcInfo>();
    for (const [service, methods] of services) {
      ctx.protoServiceNames.add(service);
      for (const method of methods) {
        const rpcId = `${wsRel}#${service}.${method.name}`;
        ctx.builder.addNode({
          id: rpcId,
          label: `${service}.${method.name}`,
          parent: wsRel,
          kind: 'rpc',
          lang: 'proto',
          meta: { file: wsRel, line: lineOf(method.index) },
        });
        const info: RpcInfo = { rpcId, protoId: wsRel, service, name: method.name };
        rpcMap.set(method.name, info);
        for (const key of new Set([method.name, lowerCamel(method.name)])) {
          let list = ctx.rpcByName.get(key);
          if (!list) {
            list = [];
            ctx.rpcByName.set(key, list);
          }
          list.push(info);
        }
        {
          const lower = method.name.toLowerCase();
          let list = ctx.rpcByNameLower.get(lower);
          if (!list) {
            list = [];
            ctx.rpcByNameLower.set(lower, list);
          }
          list.push(info);
        }
      }
    }
    if (rpcMap.size > 0) ctx.rpcOfProto.set(wsRel, rpcMap);

    // go import パスの索引: 実際のディレクトリ由来のパスと、proto パッケージ名由来のサフィックス
    if (modPath) {
      const relInModule =
        dir === project.rootRel ? '' : project.rootRel === '' ? dir : dir.slice(project.rootRel.length + 1);
      const importPath = relInModule === '' ? modPath : modPath + '/' + relInModule;
      if (!ctx.protoGoPackage.has(importPath)) ctx.protoGoPackage.set(importPath, wsRel);
    }
    if (protoPkg) {
      const suffix = protoPkg.replace(/\./g, '/');
      const existing = ctx.protoGoPackageSuffix.get(suffix);
      if (existing === undefined) ctx.protoGoPackageSuffix.set(suffix, wsRel);
      else if (existing !== wsRel) ctx.protoGoPackageSuffix.set(suffix, null); // 曖昧
    }
  }
}

export function linkProto(ctx: Ctx, state: ProtoState): void {
  for (const file of state.files) {
    for (const spec of file.imports) {
      if (spec.startsWith('google/protobuf/')) continue;
      let target: string | undefined;
      const candidates = ctx.protoFiles.filter(
        (p) => p.wsRel === spec || p.wsRel.endsWith('/' + spec),
      );
      if (candidates.length > 0) {
        // 最短パス(= 最も浅い一致)を選ぶ
        candidates.sort((a, b) => a.wsRel.length - b.wsRel.length);
        target = candidates[0].id;
      }
      if (target) ctx.builder.addEdge(file.id, target, 'import');
      else ctx.builder.warn(`proto import が解決できません: ${file.id} → "${spec}"`);
    }
  }
}
