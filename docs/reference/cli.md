---
title: CLI
layout: default
parent: リファレンス
nav_order: 1
---

# CLI リファレンス

```
strata <command> [dir|model.json] [options]
```

| コマンド | 何をするか | 主なオプション |
| --- | --- | --- |
| `scan` | 解析してモデル(JSON)を書き出す | `-o model.json` |
| `serve` | ローカルサーバーでビューアを開く | `--port N`(既定 7333)、`--watch` |
| `export` | 自己完結 HTML を書き出す(共有用) | `-o out.html` |
| `check` | CI 検査(循環 / 禁止依存 / しきい値) | `--baseline`、`--update-baseline`、`--sarif FILE` |
| `trace` | 関数から下流 / 上流を辿る | `--depth N` |
| `report` | Markdown レポート(mermaid 図つき) | `-o report.md` |
| `diff` | 2 つの状態を比較する | `--ref <base>..<head>` |
| `metrics` | サービス結合度(Ca / Ce / 不安定度) | |
| `init` | `strata.config.json` の雛形を作る | `--force` |

## 共通オプション: `--ref`

`--ref <git ref>` を付けると、作業ツリーではなく**その ref の内容**を解析します。
ref は一時的な `git worktree` に取り出すので、いま編集中のファイルには一切触れません。

```sh
# main ブランチ時点の構造を見る(手元の変更はそのまま)
strata serve . --ref main

# リリースタグ時点の循環を検査する
strata check . --ref v1.2.0
```

`diff` では `--ref` に範囲を渡せます。

```sh
# 2 つの ref を比較する
strata diff . --ref main..feature/new-api

# ref と「いまの作業ツリー」を比較する(head を省略)
strata diff . --ref main
```

ビューアの「差分」タブからも同じ比較ができ、比較先のコミットから PR 番号を検出できた場合は
GitHub の PR へのリンクを表示します。

## よく使う組み合わせ

```sh
# 変更を監視しながら見る(保存するとブラウザが自動リロード)
strata serve . --watch

# 共有用の 1 枚 HTML(サーバー不要で開ける)
strata export . -o architecture.html

# CI: 循環だけは絶対に増やさない
strata check . --baseline

# CI: この PR で構造が悪化していないか(新規循環があれば exit 1)
strata diff . --ref origin/main
```

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 検査に通った |
| 1 | 違反あり(循環 / 禁止依存 / しきい値超過)、または実行エラー |
