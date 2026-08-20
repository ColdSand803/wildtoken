// P3-1 frontend: the console reports whether /metrics is exposed and how it is
// guarded, and does not mirror the Prometheus series themselves.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;
  // The body starts after the parameter list closes, not at the first brace: a
  // destructured parameter such as ({ dryRun }) is a brace that opens and closes
  // before the body, and counting from there extracts only the signature.
  let parens = 0;
  let paramsEnd = -1;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") parens += 1;
    if (source[index] === ")") {
      parens -= 1;
      if (parens === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  assert.notEqual(paramsEnd, -1, `could not find the parameter list of ${name}`);

  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

// renderContext gives the extracted renderer a stand-in for the card element, so
// the assertions read the markup it actually writes.
function renderContext() {
  const element = { innerHTML: "" };
  const context = vm.createContext({
    metricsEndpointStatusEl: element,
    escapeHtml: (value) =>
      String(value)
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;"),
  });
  vm.runInContext(extractFunction(read("static/js/shell.js"), "renderMetricsEndpointStatus"), context);
  return { context, element };
}

function render(status) {
  const { context, element } = renderContext();
  context.status = status;
  vm.runInContext("renderMetricsEndpointStatus(status)", context);
  return element.innerHTML;
}

test("a disabled endpoint is reported as closed, with how to enable it", () => {
  const markup = render({ enabled: false, path: "/metrics", token_required: false, configured_by_file: true });

  assert.match(markup, /已关闭/);
  // The 404 behaviour is stated: an operator curling the path gets a 404 and needs
  // to know that is the disabled state, not a routing mistake.
  assert.match(markup, /404/);
  assert.match(markup, /APP__METRICS__ENABLED|enabled = true/);
  assert.doesNotMatch(markup, /已启用/);
});

test("a guarded endpoint names the separate bearer credential", () => {
  const markup = render({ enabled: true, path: "/metrics", token_required: true, configured_by_file: true });

  assert.match(markup, /已启用/);
  assert.match(markup, /Bearer/);
  // The admin credential is not the one this endpoint takes, and saying so is the
  // point of keeping them separate.
  assert.match(markup, /与管理员令牌相互独立/);
  assert.doesNotMatch(markup, /未设置令牌/);
});

test("an enabled endpoint with no token renders the warning, not a neutral note", () => {
  const markup = render({ enabled: true, path: "/metrics", token_required: false, configured_by_file: true });

  assert.match(markup, /已启用/);
  assert.match(markup, /未设置令牌/);
  // The warning class is what makes this visually distinct from the guarded case.
  // Without it the riskiest configuration reads like ordinary status text.
  assert.match(markup, /metrics-endpoint-warn/);
  assert.match(markup, /流量规模与渠道健康/);
});

test("a missing field reads as unknown rather than as disabled", () => {
  // An older gateway omits metrics_endpoint entirely. Rendering the absent field's
  // default-false as a deliberate "disabled" would state something not known.
  for (const absent of [undefined, null]) {
    const markup = render(absent);
    assert.match(markup, /不可用/);
    assert.doesNotMatch(markup, /已关闭（默认）/);
    assert.doesNotMatch(markup, /已启用/);
  }
});

test("the reported path is used rather than a hardcoded second copy", () => {
  const markup = render({ enabled: true, path: "/internal/scrape", token_required: true });
  assert.match(markup, /\/internal\/scrape/);

  // And a blank one falls back instead of rendering an empty code span.
  const fallback = render({ enabled: true, path: "", token_required: true });
  assert.match(fallback, /\/metrics/);
});

test("the card does not mirror Prometheus series into the console", () => {
  const shell = read("static/js/shell.js");
  const html = read("static/admin.html");

  // The checklist is explicit: the console keeps its own JSON metrics endpoint, and
  // two panels sourced from different contracts would disagree the moment either
  // changed. So no metric family names anywhere in the console.
  for (const family of [
    "wildtoken_http_requests_total",
    "wildtoken_http_request_duration_seconds",
    "wildtoken_tokens_total",
    "wildtoken_upstream_health_status",
  ]) {
    assert.ok(!shell.includes(family), `${family} must not be rendered by the console`);
    assert.ok(!html.includes(family), `${family} must not appear in the console markup`);
  }
});

test("the settings card exists and is marked read-only", () => {
  const html = read("static/admin.html");

  assert.match(html, /id="metrics-endpoint-status"/);
  assert.match(html, /id="metrics-endpoint-title"/);
  // Exposing the endpoint is a deployment decision, so the card must not offer a
  // switch the console cannot save.
  // Bounded by this card's own closing tag rather than by whichever card happens to
  // follow it: the original boundary was the security card, so inserting anything
  // between the two made a later card's controls read as this one's.
  const cardStart = html.indexOf('aria-labelledby="metrics-endpoint-title"');
  const card = html.slice(cardStart, html.indexOf("</section>", cardStart));
  assert.match(card, /settings-readonly-tag/);
  assert.ok(!/<input|<select|<button/.test(card), "the read-only card must not contain controls");
});

test("bootstrap wires the card element and the warning style exists", () => {
  assert.match(read("static/js/bootstrap.js"), /#metrics-endpoint-status/);
  assert.match(read("static/css/enhancements.css"), /\.metrics-endpoint-warn/);
});
