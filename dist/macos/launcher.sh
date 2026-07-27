#!/bin/bash
# Strata.app のランチャー(Contents/MacOS/Strata として配置される)。
#
# 端末を開かずに使えるようにするための薄い層で、やることは 4 つだけ:
#   1. 解析するフォルダを決める(登録済みがあればそれ、無ければフォルダ選択ダイアログ)
#   2. 空きポートを探して同梱の strata バイナリで serve を起動する
#   3. 既定ブラウザでビューアを開く
#   4. 「終了」を押すまで常駐し、終了時にサーバを確実に止める
#
# Finder から起動されると作業ディレクトリが / になるので、パスはすべて絶対で扱う。

set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
# 本体バイナリは strata-cli。ケースインセンシティブな macOS では
# `strata` にすると実行ファイル `Strata` と衝突して上書きされてしまう。
BIN="$HERE/strata-cli"
LOG_DIR="$HOME/Library/Logs"
LOG="$LOG_DIR/Strata.log"
REG="${STRATA_CONFIG_DIR:-$HOME/.config/strata}/projects.json"
SERVER_PID=""

mkdir -p "$LOG_DIR"

dialog() { # 本文 ボタン群 既定ボタン → 押されたボタン名を stdout へ
  osascript -e "display dialog \"$1\" buttons $2 default button \"$3\" with title \"Strata\"" \
    2>/dev/null | sed -n 's/.*button returned:\([^,]*\).*/\1/p'
}

alert() {
  osascript -e "display dialog \"$1\" buttons {\"OK\"} default button \"OK\" with title \"Strata\" with icon stop" \
    >/dev/null 2>&1
}

choose_folder() {
  local picked
  picked=$(osascript -e 'POSIX path of (choose folder with prompt "Strata で解析するリポジトリのフォルダを選んでください")' 2>/dev/null) || return 1
  [ -n "$picked" ] || return 1
  # POSIX path は末尾に / が付く
  printf '%s' "${picked%/}"
}

# 直近に登録されたプロジェクトのうち、いま存在するものを 1 つ返す
last_project() {
  [ -f "$REG" ] || return 1
  local p
  while IFS= read -r p; do
    [ -d "$p" ] && printf '%s' "$p" && return 0
  done < <(grep -o '"path": *"[^"]*"' "$REG" | sed 's/.*"path": *"\(.*\)"/\1/' | tail -r)
  return 1
}

port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

find_port() {
  local p
  for p in $(seq 7333 7353); do
    if port_free "$p"; then printf '%s' "$p"; return 0; fi
  done
  return 1
}

stop_server() {
  if [ -n "$SERVER_PID" ] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    wait "$SERVER_PID" 2>/dev/null
  fi
  SERVER_PID=""
}
trap stop_server EXIT INT TERM

start_server() { # $1 = 解析するディレクトリ, $2 = ポート
  : > "$LOG"
  "$BIN" serve "$1" --port "$2" >>"$LOG" 2>&1 &
  SERVER_PID=$!
  # 起動待ち(解析に時間がかかるリポジトリもあるので長めに待つ)
  local i
  for i in $(seq 1 600); do
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then return 1; fi
    if ! port_free "$2"; then return 0; fi
    sleep 0.2
  done
  return 1
}

# ---- 1. 対象フォルダを決める ----
TARGET="$(last_project || true)"
if [ -z "$TARGET" ]; then
  TARGET="$(choose_folder)" || exit 0 # キャンセルは正常終了
fi

while :; do
  # ---- 2. サーバを起動する ----
  PORT="$(find_port)" || { alert "空きポートが見つかりませんでした(7333〜7353)。"; exit 1; }
  if ! start_server "$TARGET" "$PORT"; then
    stop_server
    alert "Strata を起動できませんでした。$(printf '\\n')ログ: ~/Library/Logs/Strata.log$(printf '\\n\\n')$(tail -n 3 "$LOG" | tr '"' "'" | tr '\n' ' ')"
    exit 1
  fi
  URL="http://127.0.0.1:$PORT/"
  open "$URL"

  # ---- 3. 常駐して操作を受ける ----
  while :; do
    ANSWER="$(dialog "Strata が動いています。$(printf '\\n\\n')フォルダ: $TARGET$(printf '\\n')URL: $URL" '{"終了", "別のフォルダ…", "ブラウザを開く"}' 'ブラウザを開く')"
    case "$ANSWER" in
      'ブラウザを開く') open "$URL" ;;
      '別のフォルダ…')
        NEXT="$(choose_folder)" || continue
        TARGET="$NEXT"
        stop_server
        break # 外側のループで選び直したフォルダを起動し直す
        ;;
      *) # 「終了」またはダイアログが閉じられた
        stop_server
        exit 0
        ;;
    esac
  done
done
