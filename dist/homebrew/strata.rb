# Homebrew formula for Strata.
#
# 更新手順(新しいタグを切ったあと):
#   1. タグ(例 v0.1.5)を push する
#   2. 下の version / url / sha256 を更新する
#        curl -fsSL https://github.com/makoto-developer/strata/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
#   3. tap 用リポジトリ makoto-developer/homebrew-strata の Formula/strata.rb に反映する
#   4. 利用者は次で導入:
#        brew tap makoto-developer/strata
#        brew install strata
#
# ソースを配置し、Homebrew の node で実行する。Strata は実行時依存ゼロ・ビルド不要で、
# TypeScript を type stripping のまま実行するので、OS・CPU を問わずこの一本で足りる。
class Strata < Formula
  desc "多言語・マイクロサービス対応の依存関係可視化・コールグラフ探索ツール"
  homepage "https://makoto-developer.github.io/strata/"
  url "https://github.com/makoto-developer/strata/archive/refs/tags/v0.1.4.tar.gz"
  version "0.1.4"
  sha256 "PENDING"
  license "AGPL-3.0-only"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    (bin/"strata").write <<~SH
      #!/bin/bash
      exec "#{formula_opt_bin("node")}/node" "#{libexec}/src/cli.ts" "$@"
    SH
    chmod 0755, bin/"strata"
  end

  test do
    assert_match "strata", shell_output("#{bin}/strata --version")
  end
end
