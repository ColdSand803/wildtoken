// 模块图的结构约束。这些是改造时踩过的坑，不锁住就会慢慢退化回去。
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const jsFiles = readdirSync(new URL("../static/js", import.meta.url))
  .filter((name) => name.endsWith(".js"))
  .map((name) => `static/js/${name}`);

/** 解析一个文件的 import：{ 来源模块 -> 名字集合 }。 */
function importsOf(file) {
  const found = new Map();
  for (const m of read(file).matchAll(/import\s*(?:\{([^}]*)\})?\s*(?:from\s*)?"\.\/([^"]+)";/g)) {
    const names = (m[1] || "").replace(/\n/g, " ").split(",").map((n) => n.trim()).filter(Boolean);
    const prev = found.get(m[2]) || new Set();
    for (const n of names) prev.add(n);
    found.set(m[2], prev);
  }
  return found;
}

function exportsOf(file) {
  const source = read(file);
  const names = new Set();
  for (const m of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const n of m[1].replace(/\n/g, " ").split(",")) {
      if (n.trim()) names.add(n.trim());
    }
  }
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s+(\w+)/gm)) names.add(m[1]);
  for (const m of source.matchAll(/^export\s+(?:const|let|var)\s+(\w+)/gm)) names.add(m[1]);
  return names;
}

test("每个 import 的名字都被来源模块导出", () => {
  // 少一个就是加载期 SyntaxError，整个控制台白屏。
  const exported = new Map(jsFiles.map((f) => [f.split("/").pop(), exportsOf(f)]));
  for (const file of jsFiles) {
    for (const [src, names] of importsOf(file)) {
      for (const name of names) {
        assert.ok(
          exported.get(src)?.has(name),
          `${file} 导入 ${name}，但 ${src} 没有导出`,
        );
      }
    }
  }
});

test("bootstrap 只依赖 registry，不反向依赖上层", () => {
  /* bootstrap 是所有模块的基础。它一旦 import 上层就形成环，而环里先执行的
     模块在顶层读对方的 const/let 会撞上 TDZ——改造时就是这么炸的：
     logs.js 顶层读 logRatePills，报 "Cannot access before initialization"。
     需要回调上层的地方一律走 registry。 */
  const deps = [...importsOf("static/js/bootstrap.js").keys()];
  assert.deepEqual(deps, ["registry.js"]);
});

test("registry 自己没有依赖", () => {
  // 它是打破环的那个支点，一旦有依赖就不再是支点。
  assert.equal(importsOf("static/js/registry.js").size, 0);
});

test("registry 里 invoke 的名字都有人 provide", () => {
  /* provide/invoke 靠字符串对接，拼错不会报错，只会安静地什么都不做——
     这正是改造前 typeof 守卫的老毛病，不该换个写法再犯一次。 */
  const provided = new Set();
  const invoked = new Map();
  for (const file of jsFiles) {
    const source = read(file);
    for (const m of source.matchAll(/provide\("([^"]+)"/g)) provided.add(m[1]);
    for (const m of source.matchAll(/(?:invoke|hasHook)\("([^"]+)"/g)) {
      invoked.set(m[1], file);
    }
  }
  assert.notEqual(invoked.size, 0, "应该有跨层回调");
  for (const [name, file] of invoked) {
    assert.ok(provided.has(name), `${file} 调用了 ${name}，但没有模块 provide 它`);
  }
});

test("入口把带副作用的模块都拉起来了", () => {
  /* 这些模块在顶层绑事件、读偏好、装初始视图。漏掉一个不会报错，
     只是那部分界面没人接管。 */
  const entry = read("static/js/app.js");
  for (const name of [
    "bootstrap", "conversation", "dashboard", "shell", "upstreams",
    "logs", "models", "tokens", "groups", "events",
  ]) {
    assert.match(entry, new RegExp(`import "\\./${name}\\.js";`), `入口缺少 ${name}.js`);
  }
});

test("没有遗留的经典脚本标签", () => {
  // 混用会让同一个模块被加载两次，顶层副作用跑两遍。
  const markup = read("static/admin.html");
  const tags = [...markup.matchAll(/<script[^>]*src="\/static\/js\/([^"]+)"[^>]*>/g)];
  assert.equal(tags.length, 1, "应当只有一个模块入口");
  assert.match(tags[0][0], /type="module"/);
  assert.equal(tags[0][1], "app.js");
});
