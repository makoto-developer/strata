---
title: インストールと最初の一歩
layout: default
nav_order: 3
---

# インストールと最初の一歩

## インストール

ビルド済みバイナリは現在配布していません。いずれもソースから入りますが、
ビルド不要・実行時依存ゼロなので `node` さえあれば動きます。

### git clone 版(全 OS)

Node.js **22.18 以上の 22 系、または 24 以上**が必要です(TypeScript の型ストリッピングを使うため)。
23 系は 23.5 以前で型ストリッピングが既定無効のため対象外です。

```sh
git clone https://github.com/makoto-developer/strata.git
cd strata
node src/cli.ts --help
```

`npm install` は不要です。エイリアスを張ると快適です。

```sh
alias strata='node /path/to/strata/src/cli.ts'
```

### Homebrew

```sh
brew tap makoto-developer/strata
brew trust makoto-developer/strata   # 公式以外の tap は明示的な信頼が必要(Homebrew の仕様)
brew install strata
```

`brew trust` を省くと `Refusing to load formula from untrusted tap` で止まります。
ソースから入り、Homebrew の `node` を使います(OS・CPU を問わず同じ構成です)。

### mise / asdf

`.mise.toml` を同梱しています。Node を用意して git clone 版を使う形です。詳しくは README を参照してください。

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
