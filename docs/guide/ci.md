---
title: CI で構造を守る
layout: default
parent: ガイド
nav_order: 6
---

# CI で構造を守る

## なぜ CI に置くのか

「domain 層から infra を呼ばない」といった決めごとは、レビューでは守れません。
人間は差分しか見ないので、**全体構造の劣化は差分に現れない**からです。
`strata check` はその判定を機械に任せ、違反があれば exit 1 で落とします。

## 最小構成

```yaml
name: architecture
on: [pull_request]

jobs:
  strata:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '24' }
      - run: npx --yes github:makoto-developer/strata check .
```

## 何を検査できるか

| 検査 | 設定 | 落ちる条件 |
| --- | --- | --- |
| 循環依存 | 既定で有効 | 循環が 1 つでもある |
| 禁止依存ルール | `forbidden` | 宣言した依存が存在する |
| 結合度のしきい値 | `thresholds` | 循環数・不安定度・依存先数が上限超過 |

```jsonc
{
  "forbidden": [
    { "name": "domain-no-infra", "from": "**/domain", "to": "**/infra",
      "comment": "ドメイン層はインフラを参照しない" }
  ],
  "thresholds": { "maxCycles": 0, "maxInstability": 0.85, "maxEfferent": 8 }
}
```

## 既存の負債で落ちてしまうとき

いきなり 0 件にはできないので、**現状を基準線として許容し、新規だけ落とす**やり方があります。

```sh
strata check . --update-baseline   # 今ある循環を .strata-baseline.json に記録
strata check . --baseline          # 以後は新規の循環だけ fail
```

## PR に注釈を出す(SARIF)

```yaml
      - run: npx --yes github:makoto-developer/strata check . --sarif strata.sarif || true
      - uses: github/codeql-action/upload-sarif@v3
        with: { sarif_file: strata.sarif }
```

GitHub Code Scanning に取り込まれ、**該当行に注釈**が付きます。

## 差分だけ見る

```sh
strata diff . --base origin/main   # 依存の増減・新規/解消した循環
```

「この PR で層をまたぐ依存が増えていないか」をレビュー前に確認できます。
