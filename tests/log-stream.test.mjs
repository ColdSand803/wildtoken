import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** 从 TS 源码里抠出一个函数体，剥掉类型标注后在 node 里跑。 */
function loadFunction(source, name) {
  const start = source.indexOf(`export function ${name}(`);
  assert.notEqual(start, -1, `${name} 必须存在`);
  let depth = 0;
  let index = source.indexOf("{", start);
  const bodyStart = index;
  for (; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  const signature = source.slice(start, bodyStart);
  const params = signature.slice(signature.indexOf("(") + 1, signature.lastIndexOf(")"));
  // 去掉参数和返回值的类型标注：node 不认 TS。
  const plainParams = params
    .split(",")
    .map((part) => part.split(":")[0].trim())
    .filter(Boolean)
    .join(", ");
  const body = source.slice(bodyStart, index + 1).replace(/: (string|number)\[\]/g, "");
  const context = vm.createContext({ Math, Number, String, Array, JSON });
  vm.runInContext(`function ${name}(${plainParams}) ${body}; globalThis.__fn = ${name};`, context);
  return context.__fn;
}

/* SSE 帧解析。不能用 EventSource——认证走 x-admin-token 头，原生
   EventSource 不支持自定义请求头，所以协议得自己解。 */
test("SSE 帧解析：event 与多行 data", () => {
  const parse = loadFunction(read("web/src/useLogStream.ts"), "parseStreamEvent");
  /* 比标量不比对象：解析函数在 vm 里跑，返回的对象属于沙箱的
     Object 原型，deepEqual 会报「结构相同但不是同一引用」。 */
  const shape = (frame) => {
    const event = parse(frame);
    return `${event.type}|${event.data}`;
  };

  assert.equal(shape('event: log\ndata: {"a":1}'), 'log|{"a":1}');

  // data 可以多行，用 \n 连接。
  assert.equal(shape("event: active\ndata: line1\ndata: line2"), "active|line1\nline2");

  // 冒号开头是注释（心跳常用），要丢掉。
  assert.equal(shape(": keep-alive\nevent: resync\ndata: {}"), "resync|{}");

  // 没有 event 字段时按规范缺省成 message。
  assert.equal(parse("data: bare").type, "message");

  // 值前面那个空格是分隔符的一部分，不属于数据。
  assert.equal(parse("data:  两个空格").data, " 两个空格");
});

/* 在途耗时的基准。服务端给的 elapsed_ms 是发快照那一刻的值，之后靠
   本地时钟往前推；直接拿 started_at 去减会把两端时钟偏差算进来。 */
test("在途耗时按收到快照的时刻推算", () => {
  const elapsed = loadFunction(read("web/src/useTicker.ts"), "elapsedMs");

  // 收到时已跑 1500ms，本地又过了 600ms。
  assert.equal(elapsed(1500, 1000, 1600), 2100);

  // 时钟回拨也不能给出负数。
  assert.equal(elapsed(1500, 5000, 1000), 0);
});

test("耗时格式：秒以下带小数，分钟以上不带", () => {
  const format = loadFunction(read("web/src/useTicker.ts"), "formatElapsed");

  assert.equal(format(850), "850ms");
  // 小数位是故意的：让数字看得出在动。
  assert.equal(format(2500), "2.5s");
  assert.equal(format(65_000), "1m5s");
});

/* 这些常量和旧控制台是一套，两边漂了观感就不一致。 */
test("流参数与旧控制台一致", () => {
  const next = read("web/src/useLogStream.ts");
  const legacy = read("static/js/logs.js");

  for (const [nextName, legacyName] of [
    ["BATCH_RENDER_MS", "LOG_STREAM_BATCH_RENDER_MS"],
    ["RECONNECT_MIN_MS", "LOG_STREAM_RECONNECT_MIN_MS"],
    ["RECONNECT_MAX_MS", "LOG_STREAM_RECONNECT_MAX_MS"],
  ]) {
    const nextValue = new RegExp(`${nextName} = (\\d+)`).exec(next)?.[1];
    const legacyValue = new RegExp(`${legacyName} = (\\d+)`).exec(legacy)?.[1];
    assert.ok(nextValue, `${nextName} 必须存在`);
    assert.equal(nextValue, legacyValue, `${nextName} 应与 ${legacyName} 一致`);
  }

  /* 计时 100ms：旧版为了让小数位连续跳动特意从 1000 改下来的。
     \b 不能省：/TICK_MS = 100/ 会在 "TICK_MS = 1000" 里命中，改回去也不报错。 */
  assert.match(read("web/src/useTicker.ts"), /TICK_MS = 100\b/);
  assert.match(legacy, /LOG_ACTIVE_TICK_MS = 100\b/);
});

/* 没有令牌时不能静默退出：用户在弹框里登录不会重新触发 effect，
   不排重试的话 SSE 永远连不上，除非刷新整页。实测抓到过。 */
test("未登录时排一次重试，而不是放弃", () => {
  const source = read("web/src/useLogStream.ts");
  const guard = source.slice(source.indexOf("if (!token)"), source.indexOf("let openedAt"));
  assert.match(guard, /scheduleReconnect\(\)/, "没有令牌时必须安排重连");
});
