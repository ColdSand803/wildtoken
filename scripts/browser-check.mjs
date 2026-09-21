#!/usr/bin/env node
/**
 * React 控制台的浏览器验证。
 *
 * 为什么要有这个：静态检查和 node 侧测试只证明代码能加载，不证明界面能用。
 * 上一次把控制台改成 ES 模块时，node 加载测试全绿、164 项测试全过，部署后
 * 所有按钮失效——失败模式是「渲染出来了但不响应」，只有真浏览器能看见。
 *
 * 零依赖：Node 24 自带 WebSocket，直接说 CDP，不装 puppeteer。
 *
 * 用法：
 *   node scripts/browser-check.mjs           # 复用已构建的 web/dist
 *   node scripts/browser-check.mjs --build   # 先跑 npm run build
 *
 * 端口另选，不碰 3100 上跑着的部署实例。
 */

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PORT = 3105;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const ADMIN_TOKEN = "browser-check-token-0123456789ab";
const CHROME = "google-chrome-stable";

// ── CDP ──────────────────────────────────────────────────────────────────────

/** 最小 CDP 客户端：请求应答 + 事件订阅，够这个脚本用。 */
class CDP {
  #ws;
  #nextId = 0;
  #pending = new Map();
  #handlers = new Map();

  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", () => reject(new Error(`CDP 连接失败: ${url}`)), { once: true });
    });
    const client = new CDP(ws);
    ws.addEventListener("message", (event) => {
      // 坏帧不该炸掉整场验证，但也不能吞——它本身就是个异常信号。
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        console.error(`CDP 收到非 JSON 帧：${String(event.data).slice(0, 200)}`);
        return;
      }
      client.#dispatch(message);
    });
    return client;
  }

  constructor(ws) {
    this.#ws = ws;
  }

  #dispatch(message) {
    if (message.id !== undefined) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return;
    }
    for (const handler of this.#handlers.get(message.method) ?? []) handler(message.params);
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, handler) {
    if (!this.#handlers.has(method)) this.#handlers.set(method, []);
    this.#handlers.get(method).push(handler);
  }

  close() {
    this.#ws.close();
  }
}

// ── 页面操作 ─────────────────────────────────────────────────────────────────

/**
 * 页面句柄。
 *
 * evaluate 收的是真函数而不是字符串，参数走 JSON 序列化——这样断言写在
 * 脚本里仍然是可读的 JS，编辑器也能看懂。
 */
class Page {
  constructor(cdp) {
    this.cdp = cdp;
  }

  async evaluate(fn, ...args) {
    const expression = `(${fn.toString()})(${args.map((a) => JSON.stringify(a)).join(", ")})`;
    const result = await this.cdp.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails;
      throw new Error(detail.exception?.description ?? detail.text ?? "evaluate 抛错");
    }
    return result.result.value;
  }

  async goto(url) {
    const loaded = new Promise((resolve) => this.cdp.on("Page.loadEventFired", resolve));
    await this.cdp.send("Page.navigate", { url });
    await loaded;
  }

  /** 轮询直到函数返回真值。超时把最后一次结果一起报出来，省得盲猜。 */
  async waitFor(fn, { timeout = 5000, label = "条件" } = {}, ...args) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await this.evaluate(fn, ...args);
      if (last) return last;
      await sleep(50);
    }
    throw new Error(`等待超时（${label}），最后一次取到 ${JSON.stringify(last)}`);
  }

  waitForSelector(selector, options = {}) {
    return this.waitFor(
      (sel) => document.querySelector(sel) !== null,
      { label: selector, ...options },
      selector,
    );
  }

  /** 点击。el.click() 派发的是冒泡的真事件，React 的根委托接得到。 */
  async click(selector) {
    const ok = await this.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return false;
      el.click();
      return true;
    }, selector);
    if (!ok) throw new Error(`点不到 ${selector}`);
    await sleep(60);
  }

  /**
   * 填表单。
   *
   * 受控输入框不能直接赋 value——React 记着上一次的值，input 事件里读到
   * 的还是旧的。得走原型上的原生 setter 再派发事件。
   */
  async fill(selector, value) {
    const ok = await this.evaluate(
      (sel, text) => {
        const el = document.querySelector(sel);
        if (!el) return false;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
        Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, text);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        return true;
      },
      selector,
      value,
    );
    if (!ok) throw new Error(`填不了 ${selector}`);
    await sleep(30);
  }

  async press(key) {
    await this.evaluate((k) => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true }));
    }, key);
    await sleep(60);
  }

  text(selector) {
    return this.evaluate((sel) => document.querySelector(sel)?.textContent?.trim() ?? null, selector);
  }

  count(selector) {
    return this.evaluate((sel) => document.querySelectorAll(sel).length, selector);
  }
}

// ── 进程 ─────────────────────────────────────────────────────────────────────

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", ...options });
    child.on("error", reject);
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`))));
  });
}

/**
 * 起后端。
 *
 * 先编译成临时二进制再跑：`go run` 会多包一层进程，杀掉父进程时子进程
 * 留着占端口。
 *
 * 日志全收着。服务起不来时先看它自己的日志——上一次浏览器症状是「登录
 * 失败且无任何报错」，真因是端口被占，日志第一行就写着 bind 失败。
 */
async function startServer(dataDir) {
  const binary = join(dataDir, "wildtoken");
  await run("go", ["build", "-o", binary, "./cmd/wildtoken"], { cwd: ROOT });

  const log = [];
  const server = spawn(binary, [], {
    cwd: ROOT,
    env: {
      ...process.env,
      ADMIN_TOKEN,
      APP__SERVER__HOST: "127.0.0.1",
      APP__SERVER__PORT: String(PORT),
      DATABASE_URL: `sqlite:${join(dataDir, "check.db")}?mode=rwc`,
      WILDTOKEN_LOG: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout.on("data", (chunk) => log.push(String(chunk)));
  server.stderr.on("data", (chunk) => log.push(String(chunk)));

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) {
      throw new Error(`服务退出（码 ${server.exitCode}）：\n${log.join("")}`);
    }
    try {
      const response = await fetch(`${ORIGIN}/health`);
      if (response.ok) return server;
    } catch {
      // 还没起来，接着等。
    }
    await sleep(200);
  }
  server.kill("SIGKILL");
  throw new Error(`服务 20 秒内没有就绪：\n${log.join("")}`);
}

async function launchChrome(profileDir) {
  const chrome = spawn(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-networking",
      "--disable-extensions",
      `--user-data-dir=${profileDir}`,
      // 0 让 Chrome 自选端口，写进 DevToolsActivePort，避开固定端口的碰撞。
      "--remote-debugging-port=0",
      "about:blank",
    ],
    { stdio: ["ignore", "ignore", "ignore"] },
  );

  const portFile = join(profileDir, "DevToolsActivePort");
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      const [port] = readFileSync(portFile, "utf8").split("\n");
      if (port) return { chrome, port: Number(port) };
    } catch {
      // 文件还没写出来。
    }
    await sleep(100);
  }
  chrome.kill("SIGKILL");
  throw new Error("Chrome 15 秒内没有开出调试端口");
}

async function attachPage(devtoolsPort) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const targets = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`).then((r) => r.json());
    const target = targets.find((item) => item.type === "page");
    if (target?.webSocketDebuggerUrl) return CDP.connect(target.webSocketDebuggerUrl);
    await sleep(100);
  }
  throw new Error("找不到可附着的页面目标");
}

// ── 数据准备 ─────────────────────────────────────────────────────────────────

async function adminPost(path, body) {
  const response = await fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} → ${response.status} ${await response.text()}`);
  return response.json();
}

function upstreamPayload(overrides) {
  return {
    name: "channel",
    base_url: "https://api.example.com",
    api_key: "sk-check",
    model_names: [],
    model_prefixes: [],
    model_mappings: {},
    effort_mappings: {},
    priority: 100,
    weight: 100,
    auto_weight_enabled: true,
    enabled: true,
    extra_headers: {},
    timeout_seconds: 300,
    rate_limit: null,
    group_ids: [],
    ...overrides,
  };
}

/**
 * 铺数据。
 *
 * 空库下所有表格都是空态，断言不出列数和格子内容。这里造的形状要覆盖
 * 分支：自动权重开/关、有分组/无分组、启用/停用/归档。
 */
async function seed() {
  const vip = await adminPost("/api/admin/groups", { name: "vip", description: "高优先级" });

  const auto = await adminPost(
    "/api/admin/upstreams/",
    upstreamPayload({
      name: "auto-weight-channel",
      model_names: ["gpt-4o", "gpt-4o-mini"],
      model_prefixes: ["claude-"],
      model_mappings: { fast: "gpt-4o-mini" },
      group_ids: [vip.id],
      auto_weight_enabled: true,
      weight: 120,
    }),
  );

  await adminPost(
    "/api/admin/upstreams/",
    upstreamPayload({
      name: "fixed-weight-channel",
      auto_weight_enabled: false,
      weight: 40,
      priority: 50,
    }),
  );

  const archived = await adminPost(
    "/api/admin/upstreams/",
    upstreamPayload({ name: "archived-channel", enabled: false }),
  );
  await fetch(`${ORIGIN}/api/admin/upstreams/${archived.id}/archived`, {
    method: "PATCH",
    headers: { "content-type": "application/json", "x-admin-token": ADMIN_TOKEN },
    body: JSON.stringify({ archived: true }),
  });

  await adminPost("/api/admin/tokens", { name: "check-token", description: "验证用", enabled: true });

  return { vipId: vip.id, autoId: auto.id };
}

// ── 断言 ─────────────────────────────────────────────────────────────────────

const results = [];

async function check(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✔ ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error });
    console.log(`  ✘ ${name}\n      ${error.message.split("\n").join("\n      ")}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) throw new Error(`${message}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}

// ── 主流程 ───────────────────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes("--build")) {
    await run("npm", ["run", "build"], { cwd: join(ROOT, "web") });
  }

  const dataDir = mkdtempSync(join(tmpdir(), "wildtoken-check-"));
  const profileDir = mkdtempSync(join(tmpdir(), "wildtoken-chrome-"));
  let server;
  let chrome;
  let cdp;

  try {
    console.log("起服务…");
    server = await startServer(dataDir);
    const seeded = await seed();

    console.log("起浏览器…");
    const launched = await launchChrome(profileDir);
    chrome = launched.chrome;
    cdp = await attachPage(launched.port);
    const page = new Page(cdp);

    // 收噪音。三条来路各收各的：console.error、未捕获异常、失败请求。
    const noise = { console: [], exceptions: [], requests: [] };
    let collecting = false;

    cdp.on("Runtime.consoleAPICalled", (event) => {
      if (!collecting || event.type !== "error") return;
      noise.console.push(event.args.map((a) => a.description ?? a.value).join(" "));
    });
    cdp.on("Runtime.exceptionThrown", (event) => {
      if (!collecting) return;
      noise.exceptions.push(event.exceptionDetails.exception?.description ?? event.exceptionDetails.text);
    });
    /* 带着 URL 才能判断一次失败是不是预期的。loadingFailed 本身只给 requestId。 */
    const urlByRequest = new Map();
    cdp.on("Network.requestWillBeSent", (event) => urlByRequest.set(event.requestId, event.request.url));
    cdp.on("Network.responseReceived", (event) => {
      if (!collecting || event.response.status < 400) return;
      noise.requests.push(`${event.response.status} ${event.response.url}`);
    });
    cdp.on("Network.loadingFailed", (event) => {
      if (!collecting) return;
      const url = urlByRequest.get(event.requestId) ?? "";
      // 离开日志页时 SSE 连接是被主动 abort 掉的，不算缺陷。
      if (event.canceled && url.includes("/api/admin/logs/stream")) return;
      noise.requests.push(`失败 ${event.errorText} ${url}`);
    });

    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Network.enable");

    // ── 登录 ────────────────────────────────────────────────────────────────
    // 这一段不收噪音：没令牌时各页照常发请求，401 是预期的。
    console.log("\n登录");

    await check("根路径重定向到新控制台", async () => {
      await page.goto(`${ORIGIN}/`);
      const url = await page.evaluate(() => location.pathname);
      assertEqual(url, "/console", "重定向落点");
    });

    await check("无令牌时弹出登录框", async () => {
      await page.waitForSelector("dialog.admin-token-dialog[open]");
      const heading = await page.text("dialog.admin-token-dialog h2");
      assertEqual(heading, "管理员登录", "登录框标题");
    });

    await check("输入令牌后进入控制台", async () => {
      await page.fill("dialog.admin-token-dialog input[type=password]", ADMIN_TOKEN);
      await page.click("dialog.admin-token-dialog button[type=submit]");
      await page.waitFor(
        () => document.querySelector("dialog.admin-token-dialog[open]") === null,
        { label: "登录框关闭" },
      );
      const stored = await page.evaluate(() => localStorage.getItem("wildtoken_admin_token"));
      assertEqual(stored, ADMIN_TOKEN, "令牌落盘");
    });

    // ── 主流程 ──────────────────────────────────────────────────────────────
    // 从这里开始，任何 console 错误、异常、4xx/5xx 都算缺陷。
    collecting = true;
    console.log("\n渠道页");

    await check("渠道表渲染出行", async () => {
      await page.waitFor(() => document.querySelectorAll("table.upstream-table tbody tr").length >= 2, {
        label: "渠道行",
      });
    });

    await check("表头与表体列数一致", async () => {
      const head = await page.count("table.upstream-table thead th");
      const body = await page.evaluate(
        () => document.querySelector("table.upstream-table tbody tr")?.children.length ?? 0,
      );
      assertEqual(head, 9, "表头列数");
      assertEqual(body, 9, "表体格数");
    });

    await check("分组列显示分组名而不是编号", async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("auto-weight"));
        return row?.querySelector("[data-col=groups]")?.textContent?.trim() ?? null;
      });
      assert(text?.includes("vip"), `分组格应含 vip，实际 ${JSON.stringify(text)}`);
    });

    await check("自动权重渠道显示有效/基础双值", async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("auto-weight"));
        return row?.querySelector("[data-col=weight]")?.textContent ?? null;
      });
      assert(text?.includes("/"), `应是「有效 / 基础」，实际 ${JSON.stringify(text)}`);
      assert(text?.includes("有效权重"), `应标注有效权重，实际 ${JSON.stringify(text)}`);
    });

    await check("关掉自动权重的渠道只显示固定权重", async () => {
      const text = await page.evaluate(() => {
        const rows = [...document.querySelectorAll("table.upstream-table tbody tr")];
        const row = rows.find((r) => r.querySelector("[data-col=name]")?.textContent?.includes("fixed-weight"));
        return row?.querySelector("[data-col=weight]")?.textContent ?? null;
      });
      assert(text?.includes("固定权重"), `应标注固定权重，实际 ${JSON.stringify(text)}`);
      assert(!text?.includes("/"), `不该出现有效权重，实际 ${JSON.stringify(text)}`);
    });

    /* 先断言存在再断言状态。只写「hidden 不为 false」的话，归档区根本没渲染
       也能蒙混过关——首跑就是这么蒙过去的。 */
    await check("归档区存在且默认收起", async () => {
      await page.waitForSelector(".archived-toggle", { label: "归档区" });
      const hidden = await page.evaluate(
        () => document.querySelector(".archived-body")?.hasAttribute("hidden") ?? null,
      );
      assertEqual(hidden, true, "归档区初始收起");
    });

    await check("归档区可以展开", async () => {
      await page.click(".archived-toggle");
      const hidden = await page.evaluate(
        () => document.querySelector(".archived-body")?.hasAttribute("hidden") ?? null,
      );
      assertEqual(hidden, false, "点击后展开");
      await page.click(".archived-toggle");
    });

    await check("操作菜单能打开", async () => {
      await page.click("table.upstream-table tbody tr button.action-menu-trigger");
      const items = await page.count("[role=menu] [role=menuitem]");
      assert(items > 0, "菜单项数量为 0");
      await page.press("Escape");
    });

    // ── 顶栏 ────────────────────────────────────────────────────────────────
    console.log("\n顶栏");

    await check("导航项齐全", async () => {
      const labels = await page.evaluate(() =>
        [...document.querySelectorAll(".topbar-nav .nav-link")].map((b) => b.textContent.trim()),
      );
      assert(labels.length === 6, `导航项应 6 个，实际 ${labels.length}`);
      assertEqual(labels.join(","), "看板,渠道,日志,令牌,分组,设置", "导航顺序");
    });

    await check("主题菜单能开且能选", async () => {
      await page.click(".theme-toggle");
      const open = await page.evaluate(() => !document.querySelector(".theme-menu").hidden);
      assertEqual(open, true, "菜单展开");
      await page.click("[data-theme-choice=light]");
      const applied = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-theme"),
        stored: localStorage.getItem("wildtoken_theme"),
        closed: document.querySelector(".theme-menu").hidden,
      }));
      assertEqual(applied.attr, "light", "html data-theme");
      assertEqual(applied.stored, "light", "主题落盘");
      assertEqual(applied.closed, true, "选完收起");
    });

    await check("Esc 收起主题菜单", async () => {
      await page.click(".theme-toggle");
      await page.press("Escape");
      const hidden = await page.evaluate(() => document.querySelector(".theme-menu").hidden);
      assertEqual(hidden, true, "Esc 后收起");
    });

    await check("密度切换改 html 属性并落盘", async () => {
      const before = await page.evaluate(() => document.documentElement.getAttribute("data-density"));
      await page.click(".density-toggle");
      const after = await page.evaluate(() => ({
        attr: document.documentElement.getAttribute("data-density"),
        stored: localStorage.getItem("wildtoken_density"),
      }));
      assert(after.attr !== before, `密度没变，仍是 ${after.attr}`);
      assertEqual(after.stored, after.attr, "密度落盘与属性一致");
    });

    // ── 各视图 ──────────────────────────────────────────────────────────────
    console.log("\n视图切换");

    const views = [
      { id: "dashboard", label: "看板" },
      { id: "logs", label: "日志" },
      { id: "tokens", label: "令牌" },
      { id: "groups", label: "分组" },
      { id: "settings", label: "设置" },
      { id: "upstreams", label: "渠道" },
    ];

    for (const view of views) {
      await check(`${view.label}页能渲染`, async () => {
        await page.evaluate((label) => {
          const button = [...document.querySelectorAll(".topbar-nav .nav-link")].find(
            (b) => b.textContent.trim() === label,
          );
          if (!button) throw new Error(`找不到导航项 ${label}`);
          button.click();
        }, view.label);
        await page.waitForSelector(`section.view[data-view=${view.id}] .panel`, {
          label: `${view.label}页面板`,
        });
        const active = await page.evaluate(
          (label) =>
            [...document.querySelectorAll(".topbar-nav .nav-link")]
              .find((b) => b.textContent.trim() === label)
              ?.classList.contains("active") ?? false,
          view.label,
        );
        assertEqual(active, true, `${view.label} 导航项高亮`);
      });
    }

    await check("视图切换是客户端路由，没有整页重载", async () => {
      const navigations = await page.evaluate(() => performance.getEntriesByType("navigation").length);
      assertEqual(navigations, 1, "导航条目数");
    });

    // ── 退出 ────────────────────────────────────────────────────────────────
    console.log("\n退出");

    await check("退出清掉令牌并弹回登录框", async () => {
      await page.click(".nav-logout");
      await page.waitForSelector("dialog.admin-token-dialog[open]", { label: "登录框重现" });
      const stored = await page.evaluate(() => localStorage.getItem("wildtoken_admin_token"));
      assertEqual(stored, "", "退出后令牌应清空");
    });

    // ── 噪音 ────────────────────────────────────────────────────────────────
    console.log("\n噪音");

    await check("零 console 错误", () => {
      assert(noise.console.length === 0, noise.console.join("\n"));
    });
    await check("零未捕获异常", () => {
      assert(noise.exceptions.length === 0, noise.exceptions.join("\n"));
    });
    await check("零失败请求", () => {
      assert(noise.requests.length === 0, noise.requests.join("\n"));
    });

    void seeded;
  } finally {
    cdp?.close();
    chrome?.kill("SIGKILL");
    server?.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(profileDir, { recursive: true, force: true });
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} 项通过`);
  if (failed.length > 0) process.exitCode = 1;
}

await main();
