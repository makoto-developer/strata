📖 **使い方の説明書: <https://makoto-developer.github.io/strata/>**

## インストール

実行時依存ゼロ・ビルド不要です。Node.js が 1 つあれば動きます。

```sh
# Homebrew
brew tap makoto-developer/strata
brew trust makoto-developer/strata   # 公式以外の tap は明示的な信頼が必要(Homebrew の仕様)
brew install strata

# git clone(インストール不要)
git clone https://github.com/makoto-developer/strata.git
node strata/src/cli.ts serve /path/to/your-monorepo
```

### 動作環境

| 項目 | サポート |
| --- | --- |
| Node.js | 22.18 以降(TypeScript を type stripping でそのまま実行するため) |
| OS / CPU | macOS・Linux・Windows / Intel・Apple Silicon を問わない |

---

- 📖 説明書(使い方・設定・設計の意図): <https://makoto-developer.github.io/strata/>
- ❓ 質問・不具合: <https://github.com/makoto-developer/strata/issues>
- 🧪 解析対象のサンプル: <https://github.com/makoto-developer/strata-sample-platform>
