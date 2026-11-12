import assert from "node:assert/strict";
import test from "node:test";
import { loadTS, setupDOM } from "./react-harness.mjs";

const engine = loadTS("web/src/liquidGlass.ts");
const { cornerExponent, refractionProfile, edgeField, buildMaps } = engine;

const close = (actual, expected, tolerance, message) =>
  assert.ok(Math.abs(actual - expected) <= tolerance, `${message ?? "value"}: ${actual} is not within ${tolerance} of ${expected}`);
const pixel = (map, width, x, y) => Array.from(map.slice((y * width + x) * 4, (y * width + x) * 4 + 4));
const shape = { width: 120, height: 80, radius: 24, bezel: 16, thickness: 14, ior: 1.5, frostEdge: 0.4 };

test("cornerExponent maps computed corner-shape values to a superellipse exponent", () => {
  assert.equal(cornerExponent("round"), 2);
  assert.equal(cornerExponent(""), 2, "browsers without corner-shape report nothing and draw arcs");
  assert.equal(cornerExponent("squircle"), 4);
  assert.equal(cornerExponent("superellipse(2)"), 4);
  close(cornerExponent("superellipse(1.5)"), 2 ** 1.5, 1e-9);
  // Concave, bevelled and square corners have no convex rim to refract through.
  for (const value of ["bevel", "scoop", "notch", "square", "superellipse(0.5)", "superellipse(-1)", "superellipse(infinity)", "garbage"])
    assert.equal(cornerExponent(value), null, value);
});

test("refractionProfile: glass with the refractive index of air bends nothing", () => {
  const profile = refractionProfile({ thickness: 14, bezel: 16, ior: 1, samples: 64 });
  assert.equal(profile.length, 64);
  for (const value of profile) close(value, 0, 1e-9);
});

test("refractionProfile: denser glass bends most at the rim and not at all where the surface flattens", () => {
  const profile = Array.from(refractionProfile({ thickness: 14, bezel: 16, ior: 1.5, samples: 128 }));
  const peak = Math.max(...profile);
  assert.ok(profile.every((value) => value >= -1e-9), "a convex rim only ever pulls content inward");
  assert.ok(profile[0] > 0);
  assert.ok(profile.indexOf(peak) < 64, "the strongest bend sits in the outer half of the bezel");
  assert.ok(profile.at(-1) < peak * 0.05, `inner edge ${profile.at(-1)} should be nearly flat against a peak of ${peak}`);
  const denser = Math.max(...refractionProfile({ thickness: 14, bezel: 16, ior: 2, samples: 128 }));
  assert.ok(denser > peak, "a higher index bends further");
});

test("edgeField: straight edges report exact depth and an outward unit normal", () => {
  const left = edgeField(5.5, 40, 120, 80, 24, 4);
  close(left.depth, 5.5, 1e-9);
  close(left.nx, -1, 1e-9);
  close(left.ny, 0, 1e-9);
  const bottom = edgeField(60, 77, 120, 80, 24, 4);
  close(bottom.depth, 3, 1e-9);
  close(bottom.nx, 0, 1e-9);
  close(bottom.ny, 1, 1e-9);
  // Further than one radius from every edge: no rim, so depth saturates.
  const centre = edgeField(60, 40, 120, 80, 24, 4);
  assert.equal(centre.depth, 24);
});

test("edgeField: a circular corner is the exact distance to its arc", () => {
  const offset = 10 * Math.SQRT1_2;
  const field = edgeField(24 - offset, 24 - offset, 120, 80, 24, 2);
  close(field.depth, 14, 1e-9);
  close(field.nx, -Math.SQRT1_2, 1e-9);
  close(field.ny, -Math.SQRT1_2, 1e-9);
  assert.equal(edgeField(1, 1, 120, 80, 24, 2), null, "the square tip of the box lies outside the arc");
});

test("edgeField: a squircle corner follows the superellipse, not the arc", () => {
  const radius = 24;
  // On the diagonal the superellipse |u|^4 + |v|^4 = r^4 passes through u = v = r / 2^(1/4).
  const onCurve = radius / 2 ** 0.25;
  const rim = edgeField(radius - onCurve + 1e-6, radius - onCurve + 1e-6, 120, 80, radius, 4);
  close(rim.depth, 0, 1e-4, "depth on the superellipse");
  close(Math.hypot(rim.nx, rim.ny), 1, 1e-9, "normal length");
  assert.ok(rim.nx < 0 && rim.ny < 0, "top-left normals point up and left");
  // The point where the circular arc would end is well inside the squircle.
  const onArc = radius * Math.SQRT1_2;
  const inside = edgeField(radius - onArc, radius - onArc, 120, 80, radius, 4);
  assert.ok(inside.depth > 2, `arc point should be inside the squircle, depth ${inside.depth}`);
  assert.equal(edgeField(radius - onArc - 0.5, radius - onArc - 0.5, 120, 80, radius, 2), null, "and just outside the arc");
  // Corner and straight edge agree where they meet.
  const seam = edgeField(radius, 6, 120, 80, radius, 4);
  const beside = edgeField(radius - 1e-6, 6, 120, 80, radius, 4);
  close(seam.depth, beside.depth, 1e-4, "depth is continuous across the corner seam");
});

test("buildMaps: the interior is neutral and fully frosted", () => {
  const { displacement, specular } = buildMaps({ ...shape, exponent: 4 });
  assert.equal(displacement.length, shape.width * shape.height * 4);
  assert.deepEqual(pixel(displacement, shape.width, 60, 40), [128, 128, 255, 255]);
  assert.equal(pixel(specular, shape.width, 60, 40)[3], 0);
});

test("buildMaps: each edge pulls content inward, mirrored left to right", () => {
  const { displacement, scale } = buildMaps({ ...shape, exponent: 4 });
  const [leftR, leftG] = pixel(displacement, shape.width, 0, 40);
  const [rightR, rightG] = pixel(displacement, shape.width, shape.width - 1, 40);
  const [topR, topG] = pixel(displacement, shape.width, 60, 0);
  assert.ok(leftR > 128 && rightR < 128, `left ${leftR} samples from its right, right ${rightR} from its left`);
  assert.ok(Math.abs(leftR - 128 + (rightR - 128)) <= 1, "left and right are mirror images");
  assert.equal(leftG, 128);
  assert.equal(rightG, 128);
  assert.equal(topR, 128);
  assert.ok(topG > 128, "the top edge samples from below");
  assert.ok(scale > 0 && Number.isFinite(scale));
});

test("buildMaps: air-index glass produces a neutral map and no scale", () => {
  const { displacement, scale } = buildMaps({ ...shape, exponent: 4, ior: 1 });
  assert.equal(scale, 0);
  for (let index = 0; index < displacement.length; index += 4) {
    assert.equal(displacement[index], 128);
    assert.equal(displacement[index + 1], 128);
  }
});

test("buildMaps: the bezel never reaches deeper than the corner radius", () => {
  const { displacement } = buildMaps({ ...shape, exponent: 4, bezel: 100 });
  // 30px in from the left: beyond the 24px radius, so untouched however wide a bezel was requested.
  assert.deepEqual(pixel(displacement, shape.width, 30, 40), [128, 128, 255, 255]);
});

test("buildMaps: frost thins toward the rim and never dips below the requested floor", () => {
  const { displacement } = buildMaps({ ...shape, exponent: 4 });
  const row = Array.from({ length: 60 }, (_, x) => pixel(displacement, shape.width, x, 40)[2]);
  for (let x = 1; x < row.length; x += 1) assert.ok(row[x] >= row[x - 1], `frost must not decrease inward at x=${x}`);
  assert.ok(row[0] >= Math.floor(0.4 * 255) && row[0] < 160, `rim frost ${row[0]} should sit near the 40% floor`);
  assert.equal(row.at(-1), 255);
  // The 16px bezel stays visibly clear for most of its width, but is solid again
  // before text can sit on it: controls start about 14px in from a sheet's edge.
  assert.ok(row[10] < 255, `10px in should still be thinning, got ${row[10]}`);
  assert.equal(row[13], 255, "frost is complete by 80% of the bezel");
});

test("buildMaps: arc and squircle maps differ only inside the corner boxes", () => {
  const round = buildMaps({ ...shape, exponent: 2 }).displacement;
  const squircle = buildMaps({ ...shape, exponent: 4 }).displacement;
  let cornerDifferences = 0;
  for (let y = 0; y < shape.height; y += 1) {
    for (let x = 0; x < shape.width; x += 1) {
      const inCornerBox = (x < shape.radius || x >= shape.width - shape.radius) && (y < shape.radius || y >= shape.height - shape.radius);
      const a = pixel(round, shape.width, x, y), b = pixel(squircle, shape.width, x, y);
      if (inCornerBox) { if (a.join() !== b.join()) cornerDifferences += 1; }
      else assert.deepEqual(a, b, `straight edge pixel ${x},${y}`);
    }
  }
  assert.ok(cornerDifferences > 20, `expected the corners to differ, found ${cornerDifferences} pixels`);
});

test("buildMaps: the specular highlight is a thin rim", () => {
  const { specular } = buildMaps({ ...shape, exponent: 4 });
  let lit = 0;
  for (let y = 0; y < shape.height; y += 1) {
    for (let x = 0; x < shape.width; x += 1) {
      const alpha = pixel(specular, shape.width, x, y)[3];
      if (!alpha) continue;
      lit += 1;
      const field = edgeField(x + 0.5, y + 0.5, shape.width, shape.height, shape.radius, 4);
      assert.ok(field && field.depth <= 2.5, `highlight at ${x},${y} is ${field?.depth}px deep`);
    }
  }
  assert.ok(lit > 50, `expected a visible rim, found ${lit} lit pixels`);
});

/* ── Controller ──────────────────────────────────────────────────────────
   jsdom has neither layout nor canvas, so measuring and PNG encoding are
   injected. Everything else is the production code path. */

// Hex tints on purpose: jsdom re-serialises functional colours inside custom
// properties ("rgb(1 2 3 / 50%)" comes back without the spaces), browsers do not.
function mount({ surfaces = '".glass"', tint = "#0a141ecc", params = "", supported = true, encode } = {}) {
  const env = setupDOM();
  const style = document.createElement("style");
  const declare = (value, nextTint = tint) => {
    style.textContent = value === null ? "" : `html { --lg-refraction-surfaces: ${value}; --lg-refraction-tint: ${nextTint}; ${params} }`;
  };
  declare(surfaces);
  document.head.append(style);
  const boxes = new Map();
  const encoded = [];
  const add = (box, className = "glass") => {
    const element = document.createElement("div");
    element.className = className;
    document.body.append(element);
    if (box) boxes.set(element, { radius: 20, cornerShape: "squircle", ...box });
    return element;
  };
  const glass = engine.createLiquidGlass({
    supported,
    measure: (element) => boxes.get(element) ?? null,
    encode: encode ?? ((pixels, width, height) => {
      encoded.push({ width, height, bytes: pixels.length });
      return `data:image/png;base64,${width}x${height}n${encoded.length}`;
    }),
  });
  return {
    glass, add, boxes, declare, encoded,
    filters: () => [...document.querySelectorAll("filter")],
    refraction: (element) => element.style.getPropertyValue("--lg-refraction"),
    fill: (element) => element.style.getPropertyValue("--lg-refraction-fill"),
    frames: () => new Promise((resolve) => setTimeout(resolve, 80)),
    close() { glass.destroy(); env.close(); },
  };
}

test("controller: a theme that declares no surfaces is left completely alone", () => {
  const page = mount({ surfaces: null });
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    assert.equal(page.refraction(element), "");
    assert.equal(page.filters().length, 0);
    assert.equal(document.querySelector("svg"), null, "no filter host is injected for other themes");
    assert.equal(page.encoded.length, 0);
  } finally { page.close(); }
});

test("controller: a declared surface gets its own filter and hands the tint over to it", () => {
  const page = mount();
  try {
    const element = page.add({ width: 200, height: 100 });
    const bystander = page.add({ width: 200, height: 100 }, "plain");
    page.glass.refresh();
    const [filter] = page.filters();
    assert.ok(filter, "a filter was injected");
    assert.equal(page.refraction(element), `url(#${filter.id})`);
    assert.equal(page.fill(element), "transparent", "the element's own fill would otherwise hide the refraction");
    assert.equal(page.refraction(bystander), "");
    assert.equal(filter.getAttribute("color-interpolation-filters"), "sRGB", "128 is only neutral in sRGB");
    const bend = filter.querySelector("feDisplacementMap");
    assert.ok(Number(bend.getAttribute("scale")) > 0);
    assert.equal(bend.getAttribute("xChannelSelector"), "R");
    assert.equal(bend.getAttribute("yChannelSelector"), "G");
    const images = [...filter.querySelectorAll("feImage")];
    assert.equal(images.length, 2, "displacement map and specular rim");
    for (const image of images) {
      assert.match(image.getAttribute("href"), /^data:image\/png;base64,200x100n\d$/);
      assert.equal(image.getAttribute("width"), "200");
      assert.equal(image.getAttribute("height"), "100");
    }
    assert.equal(filter.querySelector("feFlood").getAttribute("flood-color"), "#0a141ecc");
    assert.deepEqual(page.encoded.map(({ width, height, bytes }) => [width, height, bytes]), [[200, 100, 80000], [200, 100, 80000]]);
  } finally { page.close(); }
});

test("controller: equally sized surfaces share one filter, different sizes do not", () => {
  const page = mount();
  try {
    const first = page.add({ width: 200, height: 100 });
    const twin = page.add({ width: 200, height: 100 });
    const wider = page.add({ width: 260, height: 100 });
    const rounder = page.add({ width: 200, height: 100, cornerShape: "round" });
    page.glass.refresh();
    assert.equal(page.refraction(first), page.refraction(twin));
    assert.notEqual(page.refraction(first), page.refraction(wider));
    assert.notEqual(page.refraction(first), page.refraction(rounder), "an arc needs a different map than a squircle");
    assert.equal(page.filters().length, 3);
  } finally { page.close(); }
});

test("controller: refreshing again changes nothing", () => {
  const page = mount();
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    const before = page.refraction(element);
    const encodes = page.encoded.length;
    page.glass.refresh();
    page.glass.refresh();
    assert.equal(page.refraction(element), before);
    assert.equal(page.filters().length, 1);
    assert.equal(page.encoded.length, encodes, "cached maps are not regenerated");
  } finally { page.close(); }
});

test("controller: browsers that cannot render SVG backdrop filters keep the blur fallback", () => {
  const page = mount({ supported: false });
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    assert.equal(page.refraction(element), "");
    assert.equal(page.fill(element), "");
    assert.equal(page.filters().length, 0);
  } finally { page.close(); }
});

test("controller: surfaces without a usable rim are skipped", () => {
  const page = mount();
  try {
    const hidden = page.add(null);
    const sharp = page.add({ width: 200, height: 100, radius: 3 });
    const bevelled = page.add({ width: 200, height: 100, cornerShape: "bevel" });
    const huge = page.add({ width: 2400, height: 1400 });
    page.glass.refresh();
    for (const element of [hidden, sharp, bevelled, huge]) assert.equal(page.refraction(element), "");
    assert.equal(page.filters().length, 0);
    assert.equal(page.encoded.length, 0);
  } finally { page.close(); }
});

test("controller: a failed encode falls back instead of pointing at a missing filter", () => {
  const page = mount({ encode: () => null });
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    assert.equal(page.refraction(element), "");
    assert.equal(page.fill(element), "", "the theme's own fill must come back with the blur");
    assert.equal(page.filters().length, 0);
  } finally { page.close(); }
});

test("controller: resizing swaps the filter and drops the stale one", () => {
  const page = mount();
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    const before = page.refraction(element);
    page.boxes.set(element, { width: 240, height: 100, radius: 20, cornerShape: "squircle" });
    page.glass.refresh();
    assert.notEqual(page.refraction(element), before);
    assert.equal(page.filters().length, 1, "the 200px filter and its data URLs are released");
    page.boxes.delete(element);
    page.glass.refresh();
    assert.equal(page.refraction(element), "");
    assert.equal(page.fill(element), "");
    assert.equal(page.filters().length, 0);
  } finally { page.close(); }
});

test("controller: removed surfaces release their filter", () => {
  const page = mount();
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    element.remove();
    page.glass.refresh();
    assert.equal(page.filters().length, 0);
  } finally { page.close(); }
});

test("controller: withdrawing the declaration restores every surface", () => {
  const page = mount();
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    assert.notEqual(page.refraction(element), "");
    page.declare("none");
    page.glass.refresh();
    assert.equal(page.refraction(element), "");
    assert.equal(page.fill(element), "");
    assert.equal(page.filters().length, 0);
    assert.equal(document.querySelector("svg"), null);
    page.declare('".glass"');
    page.glass.refresh();
    assert.notEqual(page.refraction(element), "", "and it can be switched back on");
  } finally { page.close(); }
});

test("controller: a changed tint rebuilds the filter", () => {
  const page = mount();
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    const before = page.refraction(element);
    page.declare('".glass"', "#c8d2dce6");
    page.glass.refresh();
    assert.notEqual(page.refraction(element), before);
    assert.equal(page.filters().length, 1);
    assert.equal(page.filters()[0].querySelector("feFlood").getAttribute("flood-color"), "#c8d2dce6");
  } finally { page.close(); }
});

test("controller: theme parameters reach the filter, out-of-range values are clamped", () => {
  const page = mount({ params: "--lg-refraction-blur: 3; --lg-refraction-specular: 7; --lg-refraction-ior: 1;" });
  try {
    page.add({ width: 200, height: 100 });
    page.glass.refresh();
    const [filter] = page.filters();
    // Two blurs: a hairline one so the bent rim stays crisp, and the theme's frost
    // blur, let through by the same mask as the tint so it only clouds the centre.
    const [crisp, frosted] = filter.querySelectorAll("feGaussianBlur");
    assert.ok(Number(crisp.getAttribute("stdDeviation")) < 1, "the rim must stay sharp enough to read the bend");
    assert.equal(crisp.getAttribute("in"), "SourceGraphic");
    assert.equal(frosted.getAttribute("stdDeviation"), "3");
    const bent = filter.querySelector("feDisplacementMap").getAttribute("result");
    assert.equal(frosted.getAttribute("in"), bent, "frost is laid over the refracted image, not instead of it");
    const masked = [...filter.querySelectorAll('feComposite[operator="in"]')].find((node) => node.getAttribute("in") === frosted.getAttribute("result"));
    assert.ok(masked, "the frost blur is masked");
    const mask = filter.querySelector(`[result="${masked.getAttribute("in2")}"]`);
    assert.equal(mask.localName, "feColorMatrix");
    assert.equal(mask.getAttribute("in"), filter.querySelector("feImage").getAttribute("result"), "the mask is read from the displacement map");
    // Alpha comes from the map's frost channel (0.4 at the rim, 1 in the centre).
    // The haze must hold off until the tint is a third of the way up its ramp —
    // otherwise only a hairline of the bend stays sharp — and be complete in the centre.
    const [red, green, blue, alpha, offset] = mask.getAttribute("values").trim().split(/\s+/).map(Number).slice(15);
    assert.deepEqual([red, green, alpha], [0, 0, 0]);
    const haze = (frost) => Math.min(1, Math.max(0, blue * frost + offset));
    assert.equal(haze(0.4), 0, "no haze at the rim");
    assert.equal(haze(0.4 + 0.6 * 0.33), 0, "still none a third of the way in");
    assert.ok(haze(0.4 + 0.6 * 0.7) > 0.4, "well under way by two thirds");
    close(blue + offset, 1, 1e-3, "complete in the centre");
    const order = [...filter.querySelectorAll("feMergeNode")].map((node) => node.getAttribute("in"));
    assert.ok(order.indexOf(bent) < order.indexOf(masked.getAttribute("result")), "frost sits above the sharp refraction");
    assert.equal(filter.querySelector("feFuncA").getAttribute("slope"), "1");
    assert.equal(filter.querySelector("feDisplacementMap").getAttribute("scale"), "0", "ior 1 is plain glass: no bend");
  } finally { page.close(); }
});

test("controller: an invalid selector list is treated as no declaration", () => {
  const page = mount({ surfaces: '"::::"' });
  try {
    page.add({ width: 200, height: 100 });
    assert.doesNotThrow(() => page.glass.refresh());
    assert.equal(page.filters().length, 0);
  } finally { page.close(); }
});

test("controller: surfaces that appear later are picked up without a manual refresh", async () => {
  const page = mount();
  try {
    page.glass.refresh();
    const late = page.add({ width: 180, height: 60 });
    assert.equal(page.refraction(late), "");
    await page.frames();
    assert.notEqual(page.refraction(late), "", "the mutation observer schedules a refresh");
    assert.equal(page.filters().length, 1, "the engine's own DOM writes must not feed back into more work");
  } finally { page.close(); }
});

test("controller: appearance changes re-read the theme declaration", async () => {
  const page = mount({ surfaces: "none" });
  try {
    const element = page.add({ width: 200, height: 100 });
    page.glass.refresh();
    assert.equal(page.refraction(element), "");
    page.declare('".glass"');
    window.dispatchEvent(new CustomEvent("console:appearance"));
    await page.frames();
    assert.notEqual(page.refraction(element), "");
  } finally { page.close(); }
});

test("controller: destroy removes everything it added", async () => {
  const page = mount();
  const element = page.add({ width: 200, height: 100 });
  page.glass.refresh();
  page.glass.destroy();
  assert.equal(page.refraction(element), "");
  assert.equal(document.querySelector("svg"), null);
  page.add({ width: 200, height: 100 });
  window.dispatchEvent(new CustomEvent("console:appearance"));
  await page.frames();
  assert.equal(page.filters().length, 0, "listeners and observers are gone");
  page.close();
});