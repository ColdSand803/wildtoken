import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");

test("各平台发布包包含独立 wildtokenctl，Windows 客户端保留控制台", () => {
  const release = read(".github/workflows/release.yml");
  assert.match(release, /client=wildtokenctl\.exe/);
  assert.match(release, /build\/\$client" \.\/cmd\/wildtokenctl/);
  assert.match(release, /install -m 755 "build\/\$client" "\$package\/\$client"/);
  const build = release.slice(release.indexOf("client=wildtokenctl"), release.indexOf("- name: Package"));
  assert.doesNotMatch(build, /windowsgui|EXTRA_LDFLAGS/);
  assert.match(read(".github/workflows/ci.yml"), /go build -o \/dev\/null \.\/cmd\/wildtokenctl/);
});

test("Docker 与 macOS 应用携带客户端，原有服务入口不变", () => {
  const docker = read("Dockerfile");
  assert.match(docker, /COPY skills \.\/skills/);
  assert.match(docker, /\/out\/wildtokenctl \/usr\/local\/bin\/wildtokenctl/);
  assert.match(docker, /CMD \["wildtoken"\]/);
  assert.match(read("scripts/package-macos.sh"), /MacOS\/wildtokenctl/);
  assert.match(read("scripts/smoke-macos.sh"), /"\$client".*status --json/);
});

test("Pi package 只加载 skill，不把网页主题误当成 Pi 主题", () => {
  const manifest = JSON.parse(read("package.json"));
  assert.deepEqual(manifest.pi.skills, ["./skills/wildtoken"]);
  assert.deepEqual(manifest.pi.themes, []);
  assert.deepEqual(manifest.pi.extensions, []);
  assert.deepEqual(manifest.pi.prompts, []);
});

test("Skill 明确约束授权与凭据，不绕过 CLI 直接写数据库", () => {
  const skill = read("skills/wildtoken/SKILL.md");
  assert.match(skill, /^---\nname: wildtoken\ndescription:/);
  assert.match(skill, /不直接打开、修改 SQLite/);
  assert.match(skill, /--dry-run/);
  assert.match(skill, /--apply --yes/);
  assert.match(skill, /不是新的授权/);
  assert.match(read("skills/embed.go"), /go:embed wildtoken\/SKILL\.md wildtoken\/references\/\*\.md/);
});
