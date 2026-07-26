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

  "exclude": ["experimental"],        // 除外(パス前方一致 or ディレクトリ名)
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
  "graphql": { "enabled": true }
}
```

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
