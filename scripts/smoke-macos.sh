#!/usr/bin/env bash
# 从任意工作目录启动解压后的应用，验证菜单栏、目录隔离和优雅退出。
set -euo pipefail
archive=${1:?用法：smoke-macos.sh <app.zip>}
[[ $(uname -s) == Darwin ]] || { echo '需要 macOS' >&2; exit 1; }
archive=$(cd "$(dirname "$archive")" && pwd)/$(basename "$archive")
stage=$(mktemp -d "${TMPDIR:-/tmp}/wildtoken-smoke.XXXXXX")
pid=
cleanup() {
  result=$?
  if [[ -n $pid ]]; then
    kill -TERM "$pid" 2>/dev/null || true
    for ((i=0; i<55; i++)); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 1
    done
    kill -KILL "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  if [[ $result != 0 ]]; then
    tail -60 "$stage/process.log" "$stage/home/Library/Logs/WildToken/wildtoken.log" 2>/dev/null || true
  fi
  rm -rf "$stage"
  exit "$result"
}
trap cleanup EXIT

/usr/bin/ditto -x -k "$archive" "$stage/unpacked"
bundle="$stage/unpacked/WildToken.app"
binary="$bundle/Contents/MacOS/wildtoken"
/usr/bin/plutil -lint "$bundle/Contents/Info.plist"
test "$(/usr/bin/plutil -extract LSUIElement raw "$bundle/Contents/Info.plist")" = true
test -x "$binary"
test -s "$bundle/Contents/Resources/WildToken.icns"
mkdir -p "$stage/home" "$stage/unrelated"
cd "$stage/unrelated"
# Finder 的工作目录不应成为配置来源。
printf 'ADMIN_TOKEN=wrong-cwd-token\n' > .env
data="$stage/home/Library/Application Support/WildToken"
log="$stage/home/Library/Logs/WildToken/wildtoken.log"

start() {
  mode=$1
  if [[ -f $log ]]; then : > "$log"; fi
  if [[ $mode == console ]]; then set -- --console; else set --; fi
  HOME="$stage/home" APP__SERVER__PORT=0 ADMIN_TOKEN=ci-macos-placeholder-token \
    WILDTOKEN_NO_TRAY=0 WILDTOKEN_CONSOLE=0 \
    "$binary" "$@" > "$stage/process.log" 2>&1 &
  pid=$!
  address=
  for ((i=0; i<60; i++)); do
    kill -0 "$pid" 2>/dev/null || { echo '应用提前退出' >&2; return 1; }
    if [[ -f $log ]]; then
      address=$(sed -n 's/.*WildToken starting.*address=\([^ ]*\).*/\1/p' "$log" | tail -1)
      if [[ -n $address ]] && curl -fsS --max-time 2 "http://$address/health" >/dev/null; then
        if [[ $mode == console ]] || grep -q 'WildToken menu ready' "$log"; then return; fi
      fi
    fi
    sleep 1
  done
  echo '应用启动超时' >&2
  return 1
}

stop() {
  kill -TERM "$pid"
  for ((i=0; i<55; i++)); do
    if ! kill -0 "$pid" 2>/dev/null; then
      wait "$pid"
      pid=
      return
    fi
    sleep 1
  done
  echo '应用未在排空期限内退出' >&2
  return 1
}

start gui
curl -fsS "http://$address/console" > "$stage/console.html"
grep -q 'WildToken Console' "$stage/console.html"
curl -fsS "http://$address/static/styles.css" >/dev/null
curl -fsS "http://$address/theme-packs/ark/theme.css" >/dev/null
curl -fsS -H 'x-admin-token: ci-macos-placeholder-token' "http://$address/api/admin/system" >/dev/null
test -f "$data/wildtoken.db"
test -f "$data/wildtoken.key"
test -f "$data/config/default.toml"
test ! -e "$stage/unrelated/wildtoken.db"
test ! -e "$bundle/Contents/Resources/wildtoken.db"

# 第二个实例必须在碰数据库前失败，手动备份则允许与服务并行。
if HOME="$stage/home" "$binary" --console > "$stage/second.log" 2>&1; then
  echo '重复实例未被拒绝' >&2
  exit 1
fi
HOME="$stage/home" "$binary" backup > "$stage/backup.log" 2>&1
find "$data/backups" -name 'wildtoken-*.db' | grep -q .
stop

printf '\n# preserved-by-smoke-test\n' >> "$data/config/default.toml"
start console
grep -q 'preserved-by-smoke-test' "$data/config/default.toml"
curl -fsS "http://$address/console" >/dev/null
stop
/usr/bin/sqlite3 "$data/wildtoken.db" 'PRAGMA integrity_check;' | grep -qx ok
printf 'macOS application smoke test passed\n'
