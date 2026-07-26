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
| `diff` | 2 つの状態を比較する | `--base <ref>` |
| `metrics` | サービス結合度(Ca / Ce / 不安定度) | |
| `init` | `strata.config.json` の雛形を作る | `--force` |

## よく使う組み合わせ

```sh
# 変更を監視しながら見る(保存するとブラウザが自動リロード)
strata serve . --watch

# 共有用の 1 枚 HTML(サーバー不要で開ける)
strata export . -o architecture.html

# CI: 循環だけは絶対に増やさない
strata check . --baseline
```

## 終了コード

| コード | 意味 |
| --- | --- |
| 0 | 検査に通った |
| 1 | 違反あり(循環 / 禁止依存 / しきい値超過)、または実行エラー |
