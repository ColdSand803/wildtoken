import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const UPSTREAMS_SOURCE = "internal/handlers/upstreams.go";

/** The `client_type` values the console writes for its own outbound requests. */
function probeClientTypes() {
  const source = read(UPSTREAMS_SOURCE);
  const values = [...source.matchAll(/\bprobe[A-Za-z]+\s*=\s*"([a-z-]+)"/g)].map(
    (match) => match[1],
  );
  assert.notEqual(values.length, 0, "the probe client types must exist");
  return values;
}

/**
 * The values offered by the log page's client filter.
 *
 * The list is a constant rather than something derived from the loaded page,
 * so it is read from the source instead of from rendered markup.
 */
function clientFilterOptions() {
  const source = read("web/src/pages/LogsPage.tsx");
  const declared = /const CLIENT_TYPES(?::[^=]+)? = \[([^\]]+)\]/.exec(source);
  assert.notEqual(declared, null, "the client filter list must exist");
  return [...declared[1].matchAll(/"([a-z0-9-]+)"/gi)].map((match) => match[1]);
}

test("every console probe client type is offered by the log page filter", () => {
  // The filter is a hardcoded list, so a new probe type added in Go would
  // otherwise be written to the log and then be unfilterable in the console.
  const options = clientFilterOptions();
  for (const value of probeClientTypes()) {
    assert.ok(options.includes(value), `${value} must be selectable in the client filter`);
  }
});

test("every console outbound request goes through the logging helper", () => {
  const source = read(UPSTREAMS_SOURCE);

  // One `HTTPClient.Do` should remain — the one inside sendAndLogProbe itself.
  // Any other is a request that reaches an upstream without leaving a log row.
  const sendCalls = [...source.matchAll(/HTTPClient\.Do\(/g)].length;
  assert.equal(sendCalls, 1, "outbound requests must go through sendAndLogProbe");

  // Each probe type is actually used; an unused constant means a call site was
  // wired to the wrong bucket.
  for (const value of probeClientTypes()) {
    const constant = [...source.matchAll(/\b(probe[A-Za-z]+)\s*=\s*"([a-z-]+)"/g)].find(
      (match) => match[2] === value,
    )?.[1];
    assert.match(
      source,
      new RegExp(`clientType:\\s+${constant}\\b`),
      `${constant} must be used by at least one call site`,
    );
  }
});
