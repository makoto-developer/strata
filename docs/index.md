---
title: はじめに
layout: default
nav_order: 1
---

# Strata

**マイクロサービスのコードを「層」として読むための可視化ツールです。**
Go / TypeScript / JavaScript / Python / Elixir / Protocol Buffers / GraphQL を横断し、
関数レベルの呼び出しから、gRPC・HTTP・GraphQL のサービス境界越えまでを 1 枚のグラフにします。

```sh
strata serve ./my-monorepo    # ブラウザで構造・API・アーキ図を見る
strata check ./my-monorepo    # CI で循環依存・禁止依存・しきい値を検査する
```

## これは何を解決するツールか

マイクロサービスで一番きついのは、**「この処理、どこを通ってる?」が誰にも分からなくなること**です。

- リポジトリが分かれていて、全体像を持っている人がいない
- proto を見ても、その RPC を**実際に誰が呼んでいるか**は分からない
- REST・GraphQL・gRPC が混在していて、追跡がプロトコルごとに途切れる
- 「この API はもう使われていない」と言い切れないので、消せないコードが増える

Strata はこれを**静的解析だけで**(サービスを起動せず、トレース基盤も入れず)埋めます。
設計の背景は [なぜこの形なのか]({{ site.baseurl }}/why/) にまとめました。

## Strata の性格

- 🔒 **完全ローカル・送信ゼロ**(テレメトリも更新チェックもなし。外部通信コードが存在しない)
- 📦 **実行時依存ゼロ**(`node_modules` を作らない)
- ⚡ **速い**(実測: 1,050 ファイル / 1,644 ノードのモノレポを **0.26 秒**)
- 🪶 **軽い**(本体コード 約 530KB。バイナリは Node 同梱で 37MB)
- 🔧 **言語のツールチェーン不要**(Go 未インストールでも Go を解析できる)
- 🌐 **オフラインで完結**、📤 **`export` で 1 枚の自己完結 HTML**

> **操作に迷ったら、まずカーソルを合わせてください。** 画面のほぼすべての要素に、
> 「何が起きるか」を説明するチップが出ます。`?` キーでショートカット一覧も開けます。

## 3 分で試す

```sh
# Node.js 22.18 以降があれば、ビルド不要でそのまま動きます
git clone https://github.com/makoto-developer/strata.git
cd strata
node src/cli.ts serve examples/demo
```

macOS(Apple Silicon)なら[ダブルクリックで使えるアプリ]({{ site.baseurl }}/getting-started/#macos-apple-silicon-アプリ)と
[単一実行ファイル]({{ site.baseurl }}/getting-started/#macos-apple-silicon-バイナリ)もあります。

## ドキュメントの歩き方

| 目的 | ページ |
| --- | --- |
| なぜこういう設計なのかを知りたい | [なぜこの形なのか]({{ site.baseurl }}/why/) |
| とりあえず動かしたい | [インストールと最初の一歩]({{ site.baseurl }}/getting-started/) |
| 画面の見方を知りたい | [画面の全体像]({{ site.baseurl }}/guide/viewer/) |
| ボタンの機能を知りたい | [ボタンと操作の一覧]({{ site.baseurl }}/guide/toolbar/)(画像つき) |
| 線や色の意味を知りたい | [構造ビューの読み方]({{ site.baseurl }}/guide/read-structure/)(画像つき) |
| API の追い方を知りたい | [API タブの読み方]({{ site.baseurl }}/guide/api-tab/)(画像つき) |
| gRPC 以外(REST / GraphQL)も追いたい | [プロトコル横断の追跡]({{ site.baseurl }}/guide/protocols/) |
| CI に組み込みたい | [CI で構造を守る]({{ site.baseurl }}/guide/ci/) |
| コマンド・設定を調べたい | [CLI リファレンス]({{ site.baseurl }}/reference/cli/) / [設定リファレンス]({{ site.baseurl }}/reference/config/) |
| 質問したい | [サポート]({{ site.baseurl }}/support/) |
