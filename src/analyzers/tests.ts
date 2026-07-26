// テストコードからの RPC 呼び出し検出(docs/SPEC.md §6.8)。
// テストは依存グラフからは除外したまま(includeTests: false のとき)、
// 「本番からは呼ばれないがテストは呼んでいる RPC」を区別できるように、
// RPC ノードの meta に testCallers(テストファイル数)/ testFiles を記録する。
// 対象: Go(*_test.go)と Elixir(*_test.exs)。JS/TS のテストは将来拡張。

import { readFileText, type Ctx } from '../context.ts';
import { stripSource } from '../lex.ts';
import { parseImports } from './golang.ts';
import { exStubRpcIds } from './elixir.ts';

/** Go テスト: proto スタブの import と `.RpcName(` の出現を突き合わせる。 */
function goTestRpcIds(ctx: Ctx, content: string): string[] {
  const { noComments, blanked } = stripSource(content, 'go');
  const protoIds = new Set<string>();
  for (const imp of parseImports(noComments)) {
    const exact = ctx.protoGoPackage.get(imp.path);
    if (exact) {
      protoIds.add(exact);
      continue;
    }
    // go_package と import パスが食い違う場合の救済:
    // proto パッケージ名由来のサフィックス(例 payment_service/v1)の後方一致で解決する
    for (const [suffix, protoId] of ctx.protoGoPackageSuffix) {
      if (protoId && (imp.path === suffix || imp.path.endsWith('/' + suffix))) {
        protoIds.add(protoId);
        break;
      }
    }
  }
  const out = new Set<string>();
  for (const protoId of protoIds) {
    const rpcMap = ctx.rpcOfProto.get(protoId);
    if (!rpcMap) continue;
    for (const [name, info] of rpcMap) {
      if (blanked.includes('.' + name + '(')) out.add(info.rpcId);
    }
  }
  return [...out].sort();
}

export function linkTests(ctx: Ctx): void {
  const callers = new Map<string, Set<string>>(); // rpc id -> テストファイル
  for (const p of ctx.projects) {
    for (const rel of p.testFiles) {
      let content: string;
      try {
        content = readFileText(ctx, rel);
      } catch {
        continue;
      }
      let rpcIds: string[] = [];
      if (rel.endsWith('.go')) rpcIds = goTestRpcIds(ctx, content);
      else if (rel.endsWith('.ex') || rel.endsWith('.exs')) rpcIds = exStubRpcIds(ctx, content);
      for (const rpcId of rpcIds) {
        let set = callers.get(rpcId);
        if (!set) {
          set = new Set();
          callers.set(rpcId, set);
        }
        set.add(rel);
      }
    }
  }
  for (const [rpcId, files] of callers) {
    const node = ctx.builder.get(rpcId);
    if (!node) continue;
    node.meta = {
      ...node.meta,
      testCallers: files.size,
      testFiles: [...files].sort().slice(0, 10), // ビューア表示用(上限あり)
    };
  }
}
