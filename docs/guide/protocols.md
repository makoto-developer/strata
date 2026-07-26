---
title: プロトコル横断の追跡
layout: default
parent: ガイド
nav_order: 2
---

# プロトコル横断の追跡(gRPC / HTTP / GraphQL)

## なぜ必要か

実システムの経路はプロトコルをまたぎます。

```
ブラウザ ──GraphQL──▶ サブグラフ ──REST──▶ BFF ──gRPC──▶ order ──REST──▶ shipping(Python)
                                                        └──gRPC──▶ payment ──HTTPS──▶ 外部決済 SaaS
```

gRPC だけ追えるツールでは、この経路は最初の 2 ホップで途切れます。
Strata は 3 つのプロトコルすべてに同じ枠組み(**定義・呼び出し・実装**)を当て、1 本のフローにします。

## gRPC

- `.proto` の `service` / `rpc` を定義として扱う
- クライアント側は「proto の生成スタブを import しているファイル」で RPC 名の呼び出しを探す
- サーバ側は `Unimplemented<Service>Server` の埋め込みなどから実装を特定する
- `.proto` が無い場合は `*_grpc.pb.go` から復元する

## HTTP(REST / webhook)

対応フレームワーク:

| 言語 | 検出できるもの |
| --- | --- |
| Go | gin / echo / chi(`Group` `Route` のプレフィックス込み)/ gorilla mux(`.Methods()`)/ net/http(Go 1.22 の `"GET /path"`) |
| TS / JS | Express / Fastify / Hono / Koa、Next.js App Router(`app/**/route.ts`) |
| Python | FastAPI(`APIRouter(prefix=)` 込み)/ Flask |
| Elixir | Phoenix Router(`get "/x", Ctrl, :action` と `live`) |

クライアント側は `http.Get` / `http.NewRequest` / `fetch` / `axios` / `requests` / `httpx` を検出し、
**パスを正規化**して突き合わせます。

```
https://order:8080/api/orders/{id}?x=1  →  /api/orders/{}
/api/orders/:id                         →  /api/orders/{}
`${BASE}/api/orders/${id}`              →  /api/orders/{}
fmt.Sprintf("/api/orders/%s", id)       →  /api/orders/{}
```

同じパスのルートが複数サービスにあるときは、**どれか判定できないので線を引きません**。

### webhook

`/webhooks/...` のような受信口は「外部からの受信(HTTP)」から、
どのルートにも当たらない絶対 URL への送信は「外部への送信(HTTP)」へ接続します。
受信と送信を別のノードに分けているのは、1 つにまとめると
「外部 ⇄ 自サービス」が**擬似的な循環依存**として検出されてしまうためです。

## GraphQL

- **スキーマ**: `*.graphql` / `*.gql` / `*.graphqls` と、コード中の `` gql`...` `` インライン SDL から
  Query / Mutation / Subscription のフィールドを抽出
- **リゾルバ**: Go(gqlgen の `func (r *queryResolver) Field(...)`)、TS(`resolvers = { Query: {...} }`)
- **クライアント操作**: `` gql`query {...}` `` のルート直下の選択フィールドを、スキーマのフィールドに接続
- **federation**: `extend type X @key(...)` を持つサブグラフから、`X` を所有するサブグラフへ線を引く

## 無効化

誤検出が気になる場合は設定で切れます。

```jsonc
{
  "http": { "enabled": false },
  "graphql": { "enabled": false }
}
```
