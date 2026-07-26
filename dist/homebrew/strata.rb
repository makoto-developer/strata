# Homebrew formula for Strata.
#
# 更新手順(新しいタグを切ったあと):
#   1. タグ(例 v0.1.0)を push する → release ワークフローが macOS(arm64)バイナリを添付する
#   2. 下の version / url / sha256 を更新する
#        # Apple Silicon 用バイナリ
#        gh release download vX.Y.Z -p 'strata-macos-arm64.tar.gz.sha256' -O - | awk '{print $1}'
#        # それ以外のプラットフォーム用ソース
#        curl -fsSL https://github.com/makoto-developer/strata/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
#   3. tap 用リポジトリ makoto-developer/homebrew-strata の Formula/strata.rb に反映する
#   4. 利用者は次で導入:
#        brew tap makoto-developer/strata
#        brew install strata
#
# 既定(Intel Mac / Linux)はソースを配置し、Homebrew の node で実行する
# (Strata は実行時依存ゼロ・ビルド不要で、TypeScript を type stripping のまま実行する)。
# Apple Silicon には Node.js を同梱した単一実行ファイルを配る(node の導入が要らない)。
#
# 注意: on_linux ブロックには url / sha256 を書けない(brew audit で弾かれる)。
# また on_* ブロック内で def install を定義するのも規約違反になる。
# そのため「既定 = ソース、macOS arm64 だけ url を上書き、install は 1 つに集約」という構成にしてある。
class Strata < Formula
  desc "多言語・マイクロサービス対応の依存関係可視化・コールグラフ探索ツール"
  homepage "https://makoto-developer.github.io/strata/"
  url "https://github.com/makoto-developer/strata/archive/refs/tags/v0.1.2.tar.gz"
  version "0.1.2"
  sha256 "cfabf52ed5d8de2dee11c96897abd78380ee239d0a579c50a92493b9eb9f5c12"
  license "AGPL-3.0-only"

  on_macos do
    on_arm do
      url "https://github.com/makoto-developer/strata/releases/download/v0.1.2/strata-macos-arm64.tar.gz"
      sha256 "4f335a79e76e3e8b5fd3f2bd8f545f4689b9e2e1dc0c6db07d659c03d6c32ee8"
    end

    on_intel do
      depends_on "node"
    end
  end

  on_linux do
    depends_on "node"
  end

  def install
    if OS.mac? && Hardware::CPU.arm?
      # 単一実行ファイル(Node.js 同梱)。第三者ライセンス表記も一緒に配置する
      bin.install "strata"
      pkgshare.install "THIRD-PARTY-NOTICES.txt" if File.exist?("THIRD-PARTY-NOTICES.txt")
    else
      libexec.install Dir["*"]
      (bin/"strata").write <<~SH
        #!/bin/bash
        exec "#{formula_opt_bin("node")}/node" "#{libexec}/src/cli.ts" "$@"
      SH
      chmod 0755, bin/"strata"
    end
  end

  test do
    assert_match "strata", shell_output("#{bin}/strata --version")
  end
end
