#!/bin/bash
# Strata.app を macOS(Apple Silicon)に入れるインストーラ。
#
#   curl -fsSL https://raw.githubusercontent.com/makoto-developer/strata/main/install.sh | bash
#
# やること:
#   1. リリースから dmg と .sha256 を取得し、チェックサムを照合する
#   2. マウントして Strata.app を /Applications に置く
#   3. 隔離属性を外す(Apple の公証を受けていないため、これが無いと
#      「壊れているためゴミ箱に入れる必要があります」と言われて起動できない)
#
# 環境変数:
#   STRATA_VERSION   入れたいタグ(既定: 最新リリース)
#   STRATA_APP_DIR   インストール先(既定: /Applications)
#
# パイプ経由で実行される前提なので、対話プロンプトは使わない(標準入力がスクリプト自身のため)。

set -euo pipefail

REPO="makoto-developer/strata"
APP_DIR="${STRATA_APP_DIR:-/Applications}"
DMG="Strata-macos-arm64.dmg"
TMP=""
MNT=""

die() { printf '\033[31mエラー:\033[0m %s\n' "$1" >&2; exit 1; }
info() { printf '\033[36m▸\033[0m %s\n' "$1"; }

cleanup() {
  [ -n "$MNT" ] && [ -d "$MNT" ] && hdiutil detach -quiet "$MNT" 2>/dev/null || true
  [ -n "$TMP" ] && rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

# ---- 前提の確認 ----
[ "$(uname -s)" = "Darwin" ] || die "macOS 専用です(このマシンは $(uname -s))。他の OS では git clone 版を使ってください: https://github.com/$REPO#インストール"
if [ "$(uname -m)" != "arm64" ]; then
  die "Apple Silicon 向けのみ配布しています(このマシンは $(uname -m))。Intel Mac では git clone 版を使ってください: https://github.com/$REPO#インストール"
fi
for cmd in curl shasum hdiutil xattr; do
  command -v "$cmd" >/dev/null 2>&1 || die "$cmd が見つかりません"
done

# ---- 取得するバージョンを決める ----
VERSION="${STRATA_VERSION:-}"
if [ -z "$VERSION" ]; then
  info "最新リリースを調べています"
  VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" \
    | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)
  [ -n "$VERSION" ] || die "最新リリースを取得できませんでした(ネットワークか GitHub の一時的な問題かもしれません)"
fi
BASE="https://github.com/$REPO/releases/download/$VERSION"

# ---- ダウンロードとチェックサム照合 ----
TMP=$(mktemp -d)
info "$VERSION の $DMG をダウンロードしています"
curl -fsSL "$BASE/$DMG" -o "$TMP/$DMG" || die "ダウンロードに失敗しました: $BASE/$DMG"
curl -fsSL "$BASE/$DMG.sha256" -o "$TMP/$DMG.sha256" || die "チェックサムを取得できませんでした"

info "チェックサムを照合しています"
( cd "$TMP" && shasum -a 256 -c "$DMG.sha256" >/dev/null ) \
  || die "チェックサムが一致しません。ダウンロードが壊れているか、改ざんされている可能性があります"

# ---- マウントして配置 ----
MNT="$TMP/mnt"
mkdir -p "$MNT"
hdiutil attach -quiet -nobrowse -mountpoint "$MNT" "$TMP/$DMG" || die "dmg をマウントできませんでした"

[ -d "$APP_DIR" ] || die "インストール先がありません: $APP_DIR"
[ -w "$APP_DIR" ] || die "$APP_DIR に書き込めません。管理者ユーザーで実行するか、STRATA_APP_DIR=\"\$HOME/Applications\" を指定してください"

TARGET="$APP_DIR/Strata.app"
if [ -e "$TARGET" ]; then
  info "既存の $TARGET を置き換えます"
  rm -rf "$TARGET"
fi
info "$TARGET に配置しています"
cp -R "$MNT/Strata.app" "$TARGET"

# ---- 隔離属性を外す ----
# Apple の公証を受けていないため、これをしないと macOS 15 以降は
# 「壊れているためゴミ箱に入れる必要があります」で起動できない(署名自体は正常)。
info "隔離属性を外しています"
xattr -dr com.apple.quarantine "$TARGET" 2>/dev/null || true

VER_OUT=$("$TARGET/Contents/MacOS/strata-cli" --version 2>/dev/null || echo '(確認できず)')

cat <<EOF

✅ インストールしました: $TARGET  ($VER_OUT)

  ・Launchpad か Finder から Strata をダブルクリックしてください
  ・初回は解析したいリポジトリのフォルダを選びます(次回からは前回のフォルダで開きます)
  ・終わるときは残っているウィンドウの「終了」を押してください

端末からも使いたい場合(任意):

  sudo ln -sf "$TARGET/Contents/MacOS/strata-cli" /usr/local/bin/strata

EOF
