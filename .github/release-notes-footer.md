## インストール(macOS / Apple Silicon)

```sh
curl -fsSL https://github.com/makoto-developer/strata/releases/latest/download/strata-macos-arm64.tar.gz | tar xz
sudo mv strata /usr/local/bin/
strata --version
```

### 動作環境

| 項目 | サポート |
| --- | --- |
| OS | macOS 13 Ventura 以降 |
| CPU | Apple Silicon(M1 / M2 / M3 / M4 …)。Intel Mac 用バイナリはありません |
| 同梱ランタイム | Node.js v24.18.0(別途 Node のインストールは不要) |

Intel Mac・Linux・Windows で使う場合は、Node.js 22.18 以降を入れて
`git clone` 版を使ってください(バイナリと同じ機能が動きます)。

### 署名について

このバイナリは ad-hoc 署名のみで、Apple の公証(notarization)は受けていません。
上記のように `curl` で取得した場合はそのまま実行できますが、**ブラウザでダウンロードした場合**は
隔離属性が付いて起動できないことがあります。その場合は次で外してください。

```sh
xattr -d com.apple.quarantine ./strata
```
