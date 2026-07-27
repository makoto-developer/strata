---
title: インストールと最初の一歩
layout: default
nav_order: 3
---

# インストールと最初の一歩

## インストール

### macOS(Apple Silicon)アプリ

端末を使わずに始めたい場合はこちら。インストールの 1 行だけ実行してください。

```sh
curl -fsSL https://raw.githubusercontent.com/makoto-developer/strata/main/install.sh | bash
```

`/Applications/Strata.app` に入るので、あとは Launchpad や Finder から**ダブルクリックするだけ**です。
初回はフォルダ選択が出るので解析したいリポジトリを選びます(2 回目以降は前回のフォルダで起動)。
ビューアが既定のブラウザで開き、小さなウィンドウが残るので、終わるときは「終了」を押してください。
サーバも一緒に止まります。

インストーラは dmg を取得してチェックサムを照合し、配置したうえで**隔離属性を外します**。
この最後の手順が要るのは、Apple の**公証(notarization)を受けていない**ためです。
dmg を手でドラッグした場合は、代わりに次を 1 回実行してください。

```sh
xattr -dr com.apple.quarantine /Applications/Strata.app
```

これをしないと「"Strata"は壊れているため開けません。ゴミ箱に入れる必要があります。」と出ます。
アプリが壊れているわけではなく、署名の検証自体は通ります。
**macOS 15 (Sequoia) 以降は「右クリック → 開く」では回避できません**(Apple が廃止したため)。

アプリの中には CLI も同梱しているので、端末からも使いたい場合は PATH に置けます。

```sh
sudo ln -sf /Applications/Strata.app/Contents/MacOS/strata-cli /usr/local/bin/strata
```

### macOS(Apple Silicon)バイナリ

CLI だけ欲しい場合。Node.js を入れずに使えます。ランタイムを同梱した単一実行ファイルです。

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

### Homebrew

```sh
brew tap makoto-developer/strata
brew trust makoto-developer/strata   # 公式以外の tap は明示的な信頼が必要(Homebrew の仕様)
brew install strata
```

`brew trust` を省くと `Refusing to load formula from untrusted tap` で止まります。
Apple Silicon では Node.js 同梱のバイナリ、Intel Mac / Linux ではソース + Homebrew の `node` が入ります。

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
