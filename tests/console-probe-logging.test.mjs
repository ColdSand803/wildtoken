import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** The `client_type` values the console writes for its own outbound requests. */
function probeClientTypes() {
  const source = read("src/handlers/admin/upstreams.rs");
  const values = [...source.matchAll(/pub\(crate\) const PROBE_[A-Z_]+: &str = "([a-z-]+)";/g)].map(
    (match) => match[1],
  );
  assert.notEqual(values.length, 0, "the probe client types must exist");
  return values;
}

/** The values offered by the log page's client filter. */
function clientFilterOptions() {
  const markup = read("static/admin.html");
  const start = markup.indexOf('<select id="log-client-filter">');
  assert.notEqual(start, -1, "the client filter must exist");
  const select = markup.slice(start, markup.indexOf("</select>", start));
  return [...select.matchAll(/<option value="([^"]*)"/g)]
    .map((match) => match[1])
    .filter(Boolean);
}

test("every console probe client type is offered by the log page filter", () => {
  // The filter is a hardcoded list, so a new probe type added in Rust would
  // otherwise be written to the log and then be unfilterable in the console.
  const options = clientFilterOptions();
  for (const value of probeClientTypes()) {
    assert.ok(options.includes(value), `${value} must be selectable in the client filter`);
  }
});

test("every console outbound request goes through the logging helper", () => {
  const source = read("src/handlers/admin/upstreams.rs");

  // One `.send()` should remain — the one inside send_and_log itself. Any other
  // is a request that reaches an upstream without leaving a log row.
  const sendCalls = [...source.matchAll(/\.send\(\)/g)].length;
  assert.equal(sendCalls, 1, "outbound requests must go through send_and_log");

  // Each probe type is actually used; an unused constant means a call site was
  // wired to the wrong bucket.
  for (const value of probeClientTypes()) {
    const constant = [
      ...source.matchAll(/pub\(crate\) const (PROBE_[A-Z_]+): &str = "([a-z-]+)";/g),
    ].find((match) => match[2] === value)?.[1];
    assert.match(
      source,
      new RegExp(`client_type: ${constant}\\b`),
      `${constant} must be used by at least one call site`,
    );
  }
});
