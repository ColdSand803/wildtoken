import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`could not extract ${name}`);
}

function mappingContext() {
  const source = read("static/js/bootstrap.js");
  const context = vm.createContext({});
  for (const name of ["parseMappingLines", "parseEffortMappings", "joinMappingLines"]) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return context;
}

const parse = (context, value) => {
  context.candidate = value;
  // Copy out of the vm realm: its Object has a different prototype.
  return { ...vm.runInContext("parseEffortMappings(candidate)", context) };
};

test("思考强度映射按行解析，键统一转小写", () => {
  const context = mappingContext();

  assert.deepEqual(parse(context, "max => xhigh"), { max: "xhigh" });
  // 后端按小写匹配，大小写和多余空白都要在这里抹平。
  assert.deepEqual(parse(context, "  MAX  =>  xhigh  "), { max: "xhigh" });
  assert.deepEqual(parse(context, "max => xhigh\nxhigh => high"), {
    max: "xhigh",
    xhigh: "high",
  });
});

test("=、: 与空行的写法与模型映射保持一致", () => {
  const context = mappingContext();

  assert.deepEqual(parse(context, "max = xhigh"), { max: "xhigh" });
  assert.deepEqual(parse(context, "max: xhigh"), { max: "xhigh" });
  assert.deepEqual(parse(context, "\n\n  \n"), {});
  assert.deepEqual(parse(context, ""), {});
});

test("写错格式时报的是思考强度映射，而不是模型映射", () => {
  const context = mappingContext();

  assert.throws(() => parse(context, "max"), /思考强度映射格式错误：max/);
});

test("回填时还原成每行一条的编辑格式", () => {
  const context = mappingContext();
  context.stored = { max: "xhigh", xhigh: "high" };

  const text = vm.runInContext("joinMappingLines(stored)", context);

  assert.equal(text, "max => xhigh\nxhigh => high");
  // 回填的文本再解析一遍必须得到同一张表，否则编辑后保存会改掉配置。
  assert.deepEqual(parse(context, text), { max: "xhigh", xhigh: "high" });
});
