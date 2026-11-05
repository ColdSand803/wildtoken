import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { clientTypeOptions } from "../web/src/clientTypes.ts";

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

test("every console probe client type sits in the log page filter's probe group", () => {
  // The filter offers whatever the logs hold, so every type is selectable. The
  // probe group is a list of its own: a probe type added in Go without it
  // would be filed among the real clients.
  for (const value of probeClientTypes()) {
    assert.deepEqual(clientTypeOptions([value], [], "").probes, [value],
      `${value} must be grouped as a console probe`);
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
