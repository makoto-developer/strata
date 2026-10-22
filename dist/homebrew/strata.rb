# Homebrew formula for Strata.
#
# 更新手順:
#   1. タグを切る前に package.json / package-lock.json / src/model.ts の VERSION を
#      新しい版に揃える(揃えないと brew 上は 0.1.5 なのに strata --version が 0.1.4 を返す。
#      test/cli.smoke.mjs はこの 3 者の一致は見るが、git タグとの一致までは検査しない)
#   2. タグ(例 v0.1.5)を push する
#   3. 下の url / sha256 を更新する(version は URL から読まれるので書かない)
#        curl -fsSL https://github.com/makoto-developer/strata/archive/refs/tags/vX.Y.Z.tar.gz | shasum -a 256
#   4. revision 行と、その直前の説明コメントを消す
#      (消さないと 0.1.5_1 のような版になり、あとで消すと版番号が下がって更新管理が壊れる)
#   5. tap 用リポジトリ makoto-developer/homebrew-strata の Formula/strata.rb に反映し、
#      commit して push する(この 2 ファイルは手コピーなので、push まで済ませて初めて配布に載る)
#   6. 利用者は次で導入:
#        brew tap makoto-developer/strata
#        brew trust makoto-developer/strata   # 公式以外の tap は明示的な信頼が要る
#        brew install strata
#
# ソースを配置し、Homebrew の node で実行する。Strata は実行時依存ゼロ・ビルド不要で、
# TypeScript を type stripping のまま実行するので、OS・CPU を問わずこの一本で足りる。
class Strata < Formula
  desc "多言語・マイクロサービス対応の依存関係可視化・コールグラフ探索ツール"
  homepage "https://makoto-developer.github.io/strata/"
  url "https://github.com/makoto-developer/strata/archive/refs/tags/v0.1.4.tar.gz"
  sha256 "ad0b7ee9d6528f90404c5ce4a77ad5709a05b2bbf84cf0e4f7d5019c4c93b0cf"
  license "AGPL-3.0-only"
  # 版は据え置きのまま配布形式を SEA バイナリからソースに変えたので、
  # revision を上げないと既存の導入が brew upgrade で置き換わらない
  revision 1

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
