#!/usr/bin/env bash
# 在对应架构的 macOS 上构建菜单栏应用；CLI 发布包另行构建。
set -euo pipefail
cd "$(dirname "$0")/.."

version=${1:?用法：package-macos.sh <版本> <amd64|arm64> <输出目录>}
arch=${2:?缺少架构}
out=${3:?缺少输出目录}
[[ $(uname -s) == Darwin ]] || { echo '桌面版需要 macOS SDK' >&2; exit 1; }
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]] || { echo '版本格式无效' >&2; exit 1; }
case "$arch:$(uname -m)" in
  amd64:x86_64) label=x86_64 ;;
  arm64:arm64) label=aarch64 ;;
  *) echo '请在与目标架构一致的 macOS 上构建' >&2; exit 1 ;;
esac

mkdir -p "$out"
out=$(cd "$out" && pwd)
stage=$(mktemp -d "${TMPDIR:-/tmp}/wildtoken-app.XXXXXX")
trap 'rm -rf "$stage"' EXIT
bundle="$stage/WildToken.app"
contents="$bundle/Contents"
resources="$contents/Resources"
mkdir -p "$contents/MacOS" "$resources/web" "$resources/config"

test -f web/dist/index.html || { echo '先在 web/ 执行 npm ci && npm run build' >&2; exit 1; }
CGO_ENABLED=1 GOOS=darwin GOARCH="$arch" MACOSX_DEPLOYMENT_TARGET=12.0 \
  go build -tags desktop -trimpath -ldflags '-s -w' -o "$contents/MacOS/wildtoken" ./cmd/wildtoken
chmod 755 "$contents/MacOS/wildtoken"
cp -R static themes "$resources/"
cp -R web/dist "$resources/web/"
cp config/default.toml "$resources/config/"
cp .env.example "$resources/"

plist="$contents/Info.plist"
/usr/bin/plutil -create xml1 "$plist"
for entry in \
  'CFBundleExecutable:wildtoken' \
  'CFBundleName:WildToken' \
  'CFBundleDisplayName:WildToken' \
  'CFBundleIdentifier:io.github.liguangsheng.wildtoken' \
  'CFBundlePackageType:APPL' \
  'CFBundleInfoDictionaryVersion:6.0' \
  'CFBundleIconFile:WildToken.icns' \
  'LSMinimumSystemVersion:12.0'; do
  /usr/bin/plutil -insert "${entry%%:*}" -string "${entry#*:}" "$plist"
done
/usr/bin/plutil -insert CFBundleShortVersionString -string "${version%%-*}" "$plist"
/usr/bin/plutil -insert CFBundleVersion -string "${version%%-*}" "$plist"
/usr/bin/plutil -insert LSUIElement -bool true "$plist"
/usr/bin/plutil -insert LSMultipleInstancesProhibited -bool true "$plist"
/usr/bin/plutil -insert NSHighResolutionCapable -bool true "$plist"
/usr/bin/plutil -lint "$plist"

# 沿用现有 W 图标，生成 Finder 使用的各尺寸。
iconset="$stage/WildToken.iconset"
mkdir "$iconset"
for size in 16 32 128 256 512; do
  /usr/bin/sips -z "$size" "$size" cmd/wildtoken/assets/tray-icon.png \
    --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2))
  /usr/bin/sips -z "$double" "$double" cmd/wildtoken/assets/tray-icon.png \
    --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
/usr/bin/iconutil -c icns "$iconset" -o "$resources/WildToken.icns"

archive="$out/wildtoken-v${version}-macos-${label}-app.zip"
# 不包含 Developer ID 签名或公证；这些需要操作者提供开发者凭据。
/usr/bin/ditto -c -k --sequesterRsrc --keepParent "$bundle" "$archive"
unzip -t "$archive" >/dev/null
printf '%s\n' "$archive"
