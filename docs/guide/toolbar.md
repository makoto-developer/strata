---
title: ボタンと操作の一覧
layout: default
parent: ガイド
nav_order: 2
---

# ボタンと操作の一覧

ツールバーは 2 段です。**1 段目はどの画面でも共通**、**2 段目は構造ビュー専用**の絞り込みです
(他のタブでは自動で隠れます)。

## 1 段目(共通)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/guide/toolbar-main-dark.png">
  <img alt="1 段目のツールバー" src="{{ site.baseurl }}/assets/guide/toolbar-main-light.png">
</picture>

| 位置 | ボタン | 何が起きるか |
| --- | --- | --- |
| 左 | **Strata / プロジェクト名** | プロジェクト名をクリックすると、読み込むリポジトリの管理画面へ移動します |
| 中央 | **構造 / API / 図 / エントリーポイント / プロジェクト** | 画面(タブ)の切り替え。それぞれの役割は[画面の全体像]({{ site.baseurl }}/guide/viewer/)を参照 |
| 右 | **検索窓**(`/` キー) | ノード名で絞り込みます。一致した行だけが残り、親は自動で開きます |
| 右 | **テストを除外 / ƒ 関数 / ⚡ RPC / ファイル** | 検索の対象を絞るチップ。クリックで ON / OFF |
| 右 | **← →** | フォーカスした位置の履歴を戻る / 進む(`⌥ + ←` / `⌥ + →`) |
| 右 | **トレース** | スタックトレース解析。panic やエラーログを貼り付けると、該当する関数・行にジャンプできます |
| 右 | **?** | キーボード / 操作ショートカットの一覧 |
| 右 | **再解析(円弧アイコン)** | いまのコードを解析し直して表示を更新します。**表示位置・検索条件は保持**されます |
| 右 | **テーマ(半月アイコン)** | 自動(OS 設定) → ライト → ダーク の順に切り替え。選択はブラウザに保存されます |

## 2 段目(構造ビュー専用)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/guide/toolbar-context-dark.png">
  <img alt="2 段目のツールバー" src="{{ site.baseurl }}/assets/guide/toolbar-context-light.png">
</picture>

| ボタン | 何が起きるか | 使いどころ |
| --- | --- | --- |
| **概観** | サービス単位まで畳む | 全体像を掴む。最初に押すボタン |
| **モジュール** | go.mod / package.json 単位まで開く | サービス内の構成を見る |
| **全展開** | 関数レベルまで一気に開く | 小さいリポジトリの全体把握 |
| **折りたたみ** | すべて畳む | やり直したいとき |
| **並び(セレクト)** | レベル化 / 名前順 / サイズ順 | **レベル化**は依存の向きから層を作り、地層の帯を敷きます(既定) |
| **サービス絞り込み** | 1 つのサービスだけ表示 | 特定サービスの周辺だけ見たいとき |
| **import / call / RPC境界** | その種類の依存線を表示 / 非表示 | 線が多すぎるときに種類で減らす |
| **⚠ レイヤー違反のみ** | 上向き(違反)の線だけ描画 | 違反の洗い出し。行は消えず、線だけ絞られます |

## キーボード

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/guide/help-dark.png">
  <img alt="ショートカット一覧" src="{{ site.baseurl }}/assets/guide/help-light.png">
</picture>

`?` キーでいつでも開けます。表記は実行環境に合わせて変わります(macOS では `⌥` / `⌘`)。

| キー | 動作 |
| --- | --- |
| `↑` `↓` | 行を上下に移動 |
| `→` `←` | 展開 / 折りたたみ(葉なら親子を移動) |
| `Enter` | 折りたたみを開閉 |
| `/` | 検索欄へフォーカス |
| `b` | フォーカス行をブックマーク(★) |
| `Esc` | モーダル / プレビュー / 選択を閉じる |
| `⌥ + ←` `⌥ + →` | 戻る / 進む(フォーカス履歴) |
| `⌘ + クリック` | ソース上で定義へジャンプ |
| `?` | ヘルプの開閉 |

## 画面下部(凡例とステータス)

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="{{ site.baseurl }}/assets/guide/legend-dark.png">
  <img alt="凡例バー" src="{{ site.baseurl }}/assets/guide/legend-light.png">
</picture>

- 左側は**線の意味の凡例**([構造ビューの読み方]({{ site.baseurl }}/guide/read-structure/)で詳しく説明します)
- 右側は**ステータス**: ノード数 / 依存数 / **循環** / **上向き**(レイヤー違反)の件数。
  循環と上向きの数字はクリックすると該当箇所に飛べます
- 右端の「📖 説明書」「Strata vX.Y.Z · ソース」からこのサイトとリポジトリへ行けます
