---
title: 画面の全体像
layout: default
parent: ガイド
nav_order: 1
---

# 画面の全体像

各タブが「どんな問いに答えるためのものか」から説明します。
**個々のボタンの機能**は [ボタンと操作の一覧]({{ site.baseurl }}/guide/toolbar/)、
**線やバッジの読み方**は [構造ビューの読み方]({{ site.baseurl }}/guide/read-structure/) と
[API タブの読み方]({{ site.baseurl }}/guide/api-tab/) にまとめています。

## 構造タブ — 「この依存、向きは正しいか?」

ツリー + 左側の配線で、モジュール間の依存を表示します。

- **線の向きは色で表す**: グレー = 下向き(正常)、ローズ = 上向き(**レイヤー違反**)
- **破線** = サービス境界(gRPC / HTTP / GraphQL / proto)を越える依存
- **● が依存元、▶ が依存先**。行にホバーすると、その行に繋がる線だけが残る
- **レベル化(既定の並び)**: 依存の向きからノードを層に分け、層ごとに帯を敷く

### よく使う操作

| やりたいこと | 操作 |
| --- | --- |
| 全体を俯瞰する | 「概観」ボタン(サービス単位まで畳む) |
| レイヤー違反だけ見る | 「⚠ レイヤー違反のみ」チップ |
| ノイズを減らす | 「テストを除外」チップ、依存線の種類チップ(import / call / RPC境界) |
| 気になるノードに印を付ける | 行にホバーして ☆、または `b` キー |
| 2 点間の経路を知る | ノードを選び、右パネルの「経路探索」で相手を指定 |

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/shots/structure-dark.png">
  <img alt="構造タブ" src="{{ site.baseurl }}/assets/shots/structure-light.png">
</picture>

→ 詳しい読み方: [構造ビューの読み方]({{ site.baseurl }}/guide/read-structure/)

## API タブ — 「この API は誰が呼んでいるのか?」

proto の RPC・HTTP エンドポイント・GraphQL フィールドを 1 つのカタログにまとめます。

- **呼び出し元なし(未使用?)** バッジ: このリポジトリ内から呼ばれていない API。消せる候補
- **テストのみ**: 本番コードからは呼ばれていない
- **実装なし**: 定義はあるがハンドラ / リゾルバが見つからない
- 選ぶと **上流(呼び出し元)** と **下流(実装 → その先)** のフローが出る。関数をクリックするとソースが開く

「未使用?」は消す判断に使えますが、**動的に呼ばれる経路(リフレクション等)は検出できない**点だけ注意してください。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/shots/api-dark.png">
  <img alt="API タブ" src="{{ site.baseurl }}/assets/shots/api-light.png">
</picture>

→ 詳しい読み方: [API タブの読み方]({{ site.baseurl }}/guide/api-tab/)

## 図タブ — 「サービス構成を人に説明したい」

サービス単位の箱と矢印。層(レイヤー)ごとに帯を敷き、境界の呼び出し数を
⚡RPC / ⇄HTTP / ◈GraphQL の内訳で表示します。外部システムは破線の箱です。
箱をクリックすると、そのサービスの依存元・依存先・公開 API が右パネルに出ます。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/shots/diagram-dark.png">
  <img alt="図タブ" src="{{ site.baseurl }}/assets/shots/diagram-light.png">
</picture>

## エントリーポイントタブ — 「どこから読み始めればいい?」

`func main`(プロセス起動点)、LiveView などの画面、操作イベントを一覧します。
新しくチームに入った人が最初に開くタブです。クリックすると構造タブでそのエントリーポイントにフォーカスし、
下流のトレースが始まります。

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/shots/entries-dark.png">
  <img alt="エントリーポイントタブ" src="{{ site.baseurl }}/assets/shots/entries-light.png">
</picture>

## 差分タブ — 「この変更で構造は悪くなっていないか?」

2 つの git ref(ブランチ / タグ)を選んで比較し、**サービス依存の増減**と
**新規に発生した / 解消された循環**だけを見せます。比較先を「作業ツリー」にすれば、
まだコミットしていない変更の影響も確認できます。

ref はそれぞれ一時的な `git worktree` に取り出して解析するので、**いま編集中のファイルには触れません**。
比較先のコミットメッセージから PR 番号を検出できた場合は、GitHub の PR へのリンクが出ます。

同じことは CLI でもできます(CI で使う場合はこちら):

```sh
strata diff . --ref main..feature/new-api   # 2 つの ref を比較
strata diff . --ref origin/main             # ref と作業ツリーを比較
```

新規の循環が生まれたときだけ exit 1 になるので、PR の CI にそのまま置けます。

## ソースビューア — 「実際のコードで確認したい」

- シンタックスハイライト、⌘クリックで定義ジャンプ、識別子ホバーで定義のプレビュー
- **⎇ blame**: 行ごとの最終変更コミット。クリックでコミット内容(差分・PR リンク)を表示
- 📁 ボタンでファイルツリー

## そのほか

- **📋 トレース**: panic やエラーログを貼り付けると、該当する関数・行にジャンプできます
- **キーボード**: `?` で一覧。`/` 検索、`↑↓←→` 移動と開閉、`Alt+←→` で戻る / 進む
- **テーマ**: 右上の ◐ で 自動 → ライト → ダーク
- **URL 共有**: フォーカス・検索・並びは URL に入るので、そのまま同僚に送れます
