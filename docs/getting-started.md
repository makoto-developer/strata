---
title: インストールと最初の一歩
layout: default
nav_order: 3
---

# インストールと最初の一歩

## インストール

### macOS(Apple Silicon)バイナリ

Node.js を入れずに使えます。ランタイムを同梱した単一実行ファイルです。

```sh
curl -fsSL https://github.com/makoto-developer/strata/releases/latest/download/strata-macos-arm64.tar.gz | tar xz
sudo mv strata /usr/local/bin/
strata --version
```

| 項目 | サポート |
| --- | --- |
| OS | **macOS 13 Ventura 以降** |
| CPU | **Apple Silicon(M1 / M2 / M3 / M4 …)** |
| 同梱ランタイム | Node.js v24.18.0 |
| Intel Mac / Linux / Windows | バイナリ提供なし。下の「git clone 版」を使ってください |

バイナリは ad-hoc 署名のみで Apple の公証は受けていません。`curl` 取得ならそのまま動きますが、
ブラウザでダウンロードした場合は隔離属性を外してください。

```sh
xattr -d com.apple.quarantine ./strata
```

### git clone 版(全 OS)

Node.js **22.18 以降**が必要です(TypeScript の型ストリッピングを使うため)。

```sh
git clone https://github.com/makoto-developer/strata.git
cd strata
node src/cli.ts --help
```

`npm install` は不要です。エイリアスを張ると快適です。

```sh
alias strata='node /path/to/strata/src/cli.ts'
```

### Homebrew / mise / asdf

`dist/homebrew/strata.rb` と `.mise.toml` を同梱しています。詳しくは README を参照してください。

## 最初の一歩

```sh
# 1. 同梱デモで動きを掴む
strata serve examples/demo

# 2. 自分のリポジトリを開く(モノレポならルートを指定)
strata serve ~/work/my-monorepo
```

ブラウザが `http://localhost:7333` で開きます。最初に見るとよい順番:

1. **構造タブ** — 「概観」でサービス単位まで畳み、全体の依存の向きを見る
2. **図タブ** — 箱と矢印のアーキテクチャ図。層と境界の呼び出し数を俯瞰する
3. **API タブ** — gRPC / HTTP / GraphQL のカタログ。気になる API を選ぶとフローが出る
4. **エントリーポイントタブ** — `main` や画面から「どこから読み始めるか」を決める

## 設定ファイルを作る

サービスの区切りを教えると、表示が一段見やすくなります。

```sh
strata init ~/work/my-monorepo   # strata.config.json の雛形を作る
```

```jsonc
{
  "name": "my-platform",
  "services": [
    { "name": "gateway", "path": "gateway" },
    { "name": "user", "path": "services/user" }
  ]
}
```

詳しくは [設定リファレンス]({{ site.baseurl }}/reference/config/) を参照してください。
