# Homebrew formula for Strata.
#
# 配布方法(GitHub 公開のみ・npm 非公開):
#   1. タグ(例 v0.1.0)を push する → release ワークフローが macOS(arm64)バイナリを添付する
#   2. 下の url / sha256 をそのリリースの値に更新する
#        # バイナリ(Apple Silicon 用)
#        gh release download vX.Y.Z -p 'strata-macos-arm64.tar.gz.sha256' -O - | awk '{print $1}'
#        # ソース(それ以外のプラットフォーム用)
#        gh api repos/makoto-developer/strata/tarball/vX.Y.Z | shasum -a 256
#   3. tap 用リポジトリ `makoto-developer/homebrew-strata` の Formula/ に本ファイルを置く
#   4. 利用者は次で導入:
#        brew tap makoto-developer/strata
#        brew install strata
#
# Apple Silicon には Node.js を同梱した単一実行ファイルを配る(Node のインストール不要)。
# それ以外(Intel Mac / Linux)ではソースを配置し、Homebrew の node で実行する
# (Strata は外部依存ゼロ・ビルド不要で、TypeScript を type stripping のまま実行する)。
class Strata < Formula
  desc "多言語・マイクロサービス対応の依存関係可視化・コールグラフ探索ツール"
  homepage "https://makoto-developer.github.io/strata/"
  license "AGPL-3.0-only"
  version "0.1.0"

  on_macos do
    on_arm do
      url "https://github.com/makoto-developer/strata/releases/download/v0.1.0/strata-macos-arm64.tar.gz"
      sha256 "627e81b791235d75795ecb2aa12cb2ddf9dc152143092a26f57726c6ee9ee494"

      def install
        bin.install "strata"
      end
    end

    on_intel do
      url "https://github.com/makoto-developer/strata/archive/refs/tags/v0.1.0.tar.gz"
      sha256 "95a76c7859e09f00fd1a1b141ea4aee2f4a59b0fde87fbf4cde9f17607602fb1"
      depends_on "node"

      def install
        libexec.install Dir["*"]
        (bin/"strata").write <<~SH
          #!/bin/bash
          exec "#{Formula["node"].opt_bin}/node" "#{libexec}/src/cli.ts" "$@"
        SH
        chmod 0755, bin/"strata"
      end
    end
  end

  on_linux do
    url "https://github.com/makoto-developer/strata/archive/refs/tags/v0.1.0.tar.gz"
    sha256 "95a76c7859e09f00fd1a1b141ea4aee2f4a59b0fde87fbf4cde9f17607602fb1"
    depends_on "node"

    def install
      libexec.install Dir["*"]
      (bin/"strata").write <<~SH
        #!/bin/bash
        exec "#{Formula["node"].opt_bin}/node" "#{libexec}/src/cli.ts" "$@"
      SH
      chmod 0755, bin/"strata"
    end
  end

  test do
    # バージョン表示(バイナリ版・ソース版どちらでも通る最小の確認)
    assert_match "strata", shell_output("#{bin}/strata --version")
  end
end
