import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

function mainFiles(desktop) {
  const args = ["list", "-json"];
  if (desktop) args.push("-tags", "desktop");
  args.push("./cmd/wildtoken");
  const result = spawnSync("go", args, {
    cwd: root, encoding: "utf8",
    env: { ...process.env, GOOS: "darwin", GOARCH: "arm64", CGO_ENABLED: desktop ? "1" : "0" },
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout).GoFiles;
}

test("macOS CLI 不链接桌面入口，desktop 构建单独选择", () => {
  const cli = mainFiles(false);
  assert.ok(cli.includes("desktop_other.go"));
  assert.ok(!cli.includes("desktop_darwin.go"));
  const desktop = mainFiles(true);
  assert.ok(desktop.includes("desktop_darwin.go"));
  assert.ok(!desktop.includes("desktop_other.go"));
});

test("macOS 打包和冒烟脚本符合 bash 语法", () => {
  for (const path of ["scripts/package-macos.sh", "scripts/smoke-macos.sh"]) {
    const result = spawnSync("bash", ["-n"], { cwd: root, input: read(path), encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
});

test("应用包声明菜单栏模式，并携带网页资源和默认配置", () => {
  const source = read("scripts/package-macos.sh");
  for (const pattern of [
    /go build -tags desktop/,
    /CGO_ENABLED=1/,
    /Contents/,
    /CFBundleExecutable:wildtoken/,
    /LSUIElement -bool true/,
    /LSMultipleInstancesProhibited -bool true/,
    /cp -R static themes/,
    /cp -R web\/dist/,
    /cp config\/default\.toml/,
    /--keepParent "\$bundle"/,
  ]) assert.match(source, pattern);
  assert.doesNotMatch(source, /cp\s+\.env\s/);
});

test("两个 macOS 架构都走原生测试和打包冒烟", () => {
  const workflow = read(".github/workflows/macos-app.yml");
  assert.match(workflow, /runner: macos-15-intel\s+arch: amd64/);
  assert.match(workflow, /runner: macos-15\s+arch: arm64/);
  assert.match(workflow, /go test -tags desktop -race/);
  assert.match(workflow, /scripts\/smoke-macos\.sh/);
  assert.match(read(".github/workflows/ci.yml"), /uses: \.\/\.github\/workflows\/macos-app\.yml/);
});

test("Release 保留五个原包，再加入两个桌面应用", () => {
  const release = read(".github/workflows/release.yml");
  for (const label of ["linux-x86_64", "linux-aarch64", "windows-x86_64", "macos-x86_64", "macos-aarch64"]) {
    assert.ok(release.includes(`label: ${label}`));
  }
  assert.match(release, /needs: \[prepare, build, macos-app\]/);
  assert.match(release, /Expected 7 archives/);
  assert.match(release, /uses: \.\/\.github\/workflows\/macos-app\.yml/);
});

test("应用冒烟在隔离用户目录验证 GUI、CLI、备份和排空", () => {
  const source = read("scripts/smoke-macos.sh");
  assert.match(source, /HOME="\$stage\/home"/);
  assert.match(source, /start gui/);
  assert.match(source, /start console/);
  assert.match(source, /WildToken menu ready/);
  assert.match(source, /kill -TERM/);
  assert.match(source, /"\$binary" backup/);
  assert.match(source, /preserved-by-smoke-test/);
  assert.match(source, /PRAGMA integrity_check/);
});
