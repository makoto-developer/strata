---
title: 設定
layout: default
parent: リファレンス
nav_order: 2
---

# 設定リファレンス(`strata.config.json`)

ワークスペースのルートに置きます。すべて任意です。JSONC(コメント可)で書けます。

```jsonc
{
  "name": "my-platform",

  // サービスのグルーピング(表示上の最上位階層)
  "services": [
    { "name": "gateway", "path": "gateway" },
    { "name": "user", "path": "services/user" }
  ],

  "exclude": ["experimental", "**/e2e/**"], // 除外(パス前方一致 / ディレクトリ名 / グロブ)
  "includeTests": false,              // テストコードをグラフに含めるか(既定 false)
  "testPaths": ["tools/test-client"], // テスト扱いにする追加パス

  // アーキテクチャルール(check で違反すると exit 1)
  "forbidden": [
    { "name": "domain-no-infra", "from": "**/domain", "to": "**/infra",
      "comment": "ドメイン層はインフラを参照しない" }
  ],

  // 数値しきい値(結合度の fitness function)
  "thresholds": { "maxCycles": 0, "maxInstability": 0.85, "maxEfferent": 8 },

  // 非同期(Pub/Sub)検出。誤検出を避けるため既定は無効
  "messaging": { "publish": ["Publish", "Emit"], "subscribe": ["Subscribe", "On"] },

  // HTTP(REST / webhook)検出。既定は有効
  "http": {
    "enabled": true,
    "externalHosts": true,             // 未解決の絶対 URL を「外部システム」ノードにする
    "webhookPatterns": ["/callbacks/"] // webhook 扱いにするパスの追加パターン
  },

  // GraphQL 検出。既定は有効
  "graphql": { "enabled": true },

  // 間接層(生成 gRPC クライアント経由の呼び出し)の解決。既定は無効
  "indirection": { "enabled": true },

  // IaC から環境変数の値を逆引きする(トピック名の解決)。既定は無効
  "infra": {
    "enabled": true,
    "sources": [
      { "type": "kubernetes", "path": "k8s/**/*.yaml" },
      { "type": "helm", "path": "charts/**/values.yaml" },
      { "type": "terraform", "path": "infra/**/*.tf" }
    ]
  }
}
```

## グルーピングと名前(設定なしの既定)

`services` を書かなくても、ワークスペースの形から最上位階層を組み立てます。

- **入れ子モジュールは上位のモジュールにぶら下げます。** `payments-api/tools` に独立した `go.mod` があっても、
  `payments-api` の子として扱います。
- **ワークスペース直下にリポジトリを並べた構成では、リポジトリ名でまとめます。**
  リポジトリのルートにマニフェストが無く、その下の `api/` `worker/` だけが `go.mod` を持つ場合でも、
  リポジトリ名の箱に入ります。ワークスペースのルート自身がプロジェクト(単一リポジトリ)なら、
  この暗黙のグルーピングは行いません。
- **モジュール名はマニフェストの宣言を優先します。** `package.json` の `name`、`go.mod` の `module`
  (末尾が `/v2` ならその手前)、`mix.exs` の `app:`、`pyproject.toml` の `name` の順に読み、
  どれも無ければディレクトリ名です。`<repo>/src` に `go.mod` を置く構成でも、箱の名前が `src` になりません。

`services` を書いた場合はそちらが優先されます(明示したグルーピングが常に勝ちます)。

## 間接層(`indirection`)

proto と呼び出し元の間に**生成クライアントライブラリ**が挟まる構成のための設定です。

```
proto 定義 →(tag を打って生成)→ クライアントライブラリ(別リポジトリ配布)→ 呼び出し元
```

呼び出し元が import しているのは生成物のパスであって proto のパスではないため、
既定の解決だけでは「どの RPC を呼んでいるか」が分かりません。`enabled` にすると次を行います。

```jsonc
{ "indirection": { "enabled": true } }
```

**置き場所の規約を設定する必要はありません。** 生成物かどうかは**中身**で判定します。

呼び出し側だけでなく**実装側(サーバ)も繋ぎ直します**。生成コードの `Unimplemented<Service>Server` を
埋め込んでいる型を証拠にするので、proto も生成クライアントも別リポジトリにある構成で、
「誰がその RPC を実装しているか」が図に出ます。これが無いと、呼び出しの矢印が実装サービスに届かず
共有 proto の箱に集まります。

- protoc 系の多くは `"/acme.user.v1.UserService/GetUser"` というフルメソッド名を埋め込みます
- connect-es / protobuf-es / protoc-gen-elixir のようにそれを出さないものは、
  `typeName: "acme.chat.v1.ChatService"` と RPC 名を組み合わせて復元します

そのため生成物が `vendor/` でも独自ディレクトリでも見つかります。
ただし**読みに行くファイルは拡張子・命名で足切りしています**
(`*.pb.go` / `*_grpc.pb.go` / `*_pb2_grpc.py` / `*_connect.ts` / `*_pb.d.ts` / `*.pb.ex` など)。
Bazel などで `client.go` のような名前に出力する構成では `artifactPaths` を指定してください。

```jsonc
{
  "indirection": {
    "enabled": true,
    // 既定の命名から外れる生成物や、依存パッケージ内にしか無い生成物を追加で読む
    "artifactPaths": ["third_party/**/rpc_client.go", "node_modules/@acme/**/*.js"]
  }
}
```

解決は証拠の強い順に試し、**決め手が無ければ繋ぎません**。

1. **完全修飾一致** — 呼び出し元が import している生成物の `package.Service.Method` が proto と一意に一致
2. **設定パターン** — 1 で解けない構成のための逃げ道(下記)。短名より先に試すので、
   同名 service が複数あるときの決着にも使えます
3. **短名一致** — 上で解けないときの最後の手段。次のどちらかの証拠がある場合に限り、
   `Service.Method` がワークスペース全体で一意なら接続します
   - 生成クライアントのコンストラクタで掴んでいる(`NewUserServiceClient(` / `UserServiceStub(` / `createPromiseClient(`)
   - 型注釈の修飾子が proto に解決できる import である(`orderv1.OrderServiceClient` の `orderv1`)

   型注釈だけで、修飾子も辿れない束縛は繋ぎません。手書きの `UserServiceClient` interface や
   モックと区別できないためです。

元 proto がワークスペースに無い生成物は、**その生成物自身を API 定義として登録**します
(proto が別リポジトリにあり、手元には生成クライアントしか無い構成の救済)。
判定は完全修飾名で行うので、package の違う同名 API に吸収されることはありません。

### 解決できないときのパターン指定

自動検出で解けない構成にだけ書きます。`resolveVia` が失敗しても解析は止まりません(未解決として次へ進みます)。

```jsonc
{
  "indirection": {
    "enabled": true,
    "patterns": [
      {
        "name": "internal-stub",
        "importPathPattern": "**/gen/proto/**",   // グロブ
        "resolveVia": "namingConvention",
        "namingConvention": { "importPathToService": "gen/proto/{package}/{service}" }
      }
    ]
  }
}
```

| `resolveVia` | 解決方法 |
| --- | --- |
| `packageComment` | 生成物のヘッダコメント(`// source: ...`)から復元した情報を使う |
| `namingConvention` | import パスを `{package}` / `{service}` 入りテンプレートで機械的に変換する |
| `manifest` | 生成時のマニフェスト(`manifest.path` の JSON。import パス → proto package)を読む |

### 中継層(Gateway / Federation)

「同じ RPC を実装しつつ、自分でもその RPC を呼ぶ」層は **中継候補** として印を付けます。

**層数・順序・実際の到達先は示しません。** 呼び出し元がどの実装に届くかは実行時
(サービスディスカバリや環境変数)で決まるため、静的解析では確定できないからです。
中継候補が複数あっても、それが直列とは限りません(別環境の代替経路や並列の入口のこともあります)。

## IaC からの環境変数逆引き(`infra`)

`os.Getenv("KAFKA_TOPIC")` のようにトピック名が環境変数で与えられていると、
コードだけでは publish 側と subscribe 側が同じトピックかどうか分かりません。
`infra` を有効にすると、Kubernetes マニフェスト / Helm の `values.yaml` / Terraform を読み、
「環境変数名 → 値」の対応表を作って逆引きします(`messaging` と併用します)。

読み取るのは次の形だけです(汎用の YAML / HCL パーサは持ちません)。

- Kubernetes: `env:` の配列(`- name:` / `value:`)、ConfigMap の `data:`
- Helm: `env:` のマップ(`KEY: value`)
- Terraform: `variables = { KEY = "value" }`、隣接する `name = "X"` / `value = "Y"`

**値はサービス単位にスコープを分けます。** 同じ変数名がサービスごとに別の値を持つのが普通だからです。
スコープは「ファイルの位置 → IaC 上の名前(`metadata.name` / リソースラベル)→ パス片」の順に、
**正規化後の完全一致**で当てます(`order-worker` を `order` に寄せたりはしません)。
対象サービスに設定が無いときのフォールバックは「どのサービスにも紐付かない全体既定」だけで、
**別サービスの値は流用しません**。

`fmt.Sprintf("%s.%s", svc, ev)` のように実行時に組み立てられる名前は**推測で繋がず**、
「動的生成のため未解決」として残します。

`infra` が無効なら、リテラル以外のトピック名は従来どおり無視します(未解決も増えません)。

## 未解決の参照

`indirection` / `infra` が繋げなかった参照は、モデルの `unresolved` に理由つきで残ります。
`strata unresolved` で一覧でき、ビューアの API タブにも出ます。

| 理由 | 意味 |
| --- | --- |
| `artifact` | 生成物から proto 定義を逆引きできなかった |
| `env` | 環境変数の値が IaC から解決できなかった |
| `dynamic` | トピック名が動的生成されている |

## パターンの書き方(`forbidden`)

- **グロブ**: `**/` は 0 段以上の階層、`*` は 1 階層内の任意文字
  - `**/domain` は `domain` にも `a/b/domain` にも一致します
- **グロブなし**: パス片(セグメント)単位で一致します
  - `web` は `web/src/page.ts` に一致し、`ext:http:in:webhook` には一致しません
- 照合はエッジの両端**とその祖先**に対して行われるため、パッケージ単位のルールが関数エッジにも効きます

## テスト扱いの判定

次のいずれかに当たるものはテストとみなし、グラフから外します(RPC のテスト呼び出し検出には使います)。

- ファイル名: `*_test.go` / `*_test.exs` / `*.test.ts` / `*.spec.ts` / `test_*.py` など
- ディレクトリ: `tests/` `test/` `__tests__/` `e2e/`
- `testPaths` に書いたパス
