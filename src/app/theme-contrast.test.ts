import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const css = fs.readFileSync(path.join(process.cwd(), "src/app/globals.css"), "utf8");

type Palette = "dark" | "dim" | "light";
const PALETTES: Palette[] = ["dark", "dim", "light"];
const ACCENTS = ["sun", "sky", "rose", "sand"];

function block(selector: string): Map<string, string> {
  const start = css.indexOf(`${selector} {`);
  assert.notEqual(start, -1, `no ${selector} block in globals.css`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("\n}", start));
  const declarations = new Map<string, string>();
  for (const match of body.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    declarations.set(match[1], match[2].trim());
  }
  return declarations;
}

const root = block(":root");
const dim = css.includes(`:root[data-theme="dim"] {`) ? block(`:root[data-theme="dim"]`) : new Map<string, string>();

function splitArgs(inner: string): string[] {
  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of inner) {
    if (char === "(") depth++;
    if (char === ")") depth--;
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
    } else current += char;
  }
  args.push(current.trim());
  return args;
}

function resolve(value: string, palette: Palette, accent: string, seen: string[] = []): string {
  const lightDark = value.match(/^light-dark\((.*)\)$/s);
  if (lightDark) {
    const [light, dark] = splitArgs(lightDark[1]);
    return resolve(palette === "light" ? light : dark, palette, accent, seen);
  }
  const reference = value.match(/^var\((--[\w-]+)\)$/);
  if (reference) return token(reference[1], palette, accent, seen);
  assert.match(value, /^#[0-9a-f]{6}$/i, `${seen.at(-1)} resolves to ${value}, not a hex color`);
  return value.toLowerCase();
}

function token(name: string, palette: Palette, accent = "sun", seen: string[] = []): string {
  assert.ok(!seen.includes(name), `cycle through ${name}`);
  let value = root.get(name);
  if (palette === "dim" && dim.has(name)) value = dim.get(name);
  if (name === "--orbit-sun" && accent !== "sun") value = block(`:root[data-accent="${accent}"]`).get(name);
  assert.ok(value, `no ${name} in globals.css`);
  return resolve(value, palette, accent, [...seen, name]);
}

function luminance(hex: string) {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

function check(palette: Palette, pairs: [string, string][], minimum: number, accent = "sun") {
  const failures = pairs
    .map(([fg, bg]) => ({ fg, bg, ratio: contrast(token(fg, palette, accent), token(bg, palette, accent)) }))
    .filter(({ ratio }) => ratio < minimum)
    .map(({ fg, bg, ratio }) => `${palette}${accent === "sun" ? "" : `/${accent}`}: ${fg} on ${bg} is ${ratio.toFixed(2)}, needs ${minimum}`);
  assert.deepEqual(failures, []);
}

const SURFACES = ["--background", "--card", "--popover", "--surface-sunken", "--surface-raised", "--accent", "--secondary", "--muted", "--canvas"];
const pairs = (fgs: string[], bgs: string[]) => fgs.flatMap((fg) => bgs.map((bg): [string, string] => [fg, bg]));

test("every brand primitive has a light value", () => {
  for (const name of ["--orbit-bg", "--orbit-surface", "--orbit-border", "--orbit-text", "--orbit-muted", "--orbit-ivory"]) {
    assert.match(root.get(name) ?? "", /^light-dark\(/, `no light value for ${name}`);
  }
});

for (const palette of PALETTES) {
  test(`${palette}: text reads at 4.5:1 on every surface`, () => {
    check(palette, pairs(["--foreground", "--muted-foreground"], SURFACES), 4.5);
    check(palette, [["--primary-foreground", "--primary"], ["--primary-foreground", "--destructive"]], 4.5);
  });

  test(`${palette}: status colors read at 4.5:1 where callouts set text`, () => {
    check(palette, pairs(["--info", "--positive", "--warning", "--negative"], ["--card", "--background"]), 4.5);
  });

  test(`${palette}: chart series stand out at 3:1 on cards`, () => {
    check(palette, pairs(["--chart-1", "--chart-2", "--chart-3", "--chart-4", "--chart-5"], ["--card"]), 3);
  });

  test(`${palette}: each accent preset stands out at 3:1`, () => {
    for (const accent of ACCENTS) {
      check(palette, pairs(["--sun"], ["--background", "--card", "--accent", "--popover", "--surface-sunken", "--surface-raised"]), 3, accent);
    }
  });

  test(`${palette}: code colors read on the code surface`, () => {
    const syntax = ["keyword", "string", "number", "function", "punctuation", "builtin", "class", "operator"].map((name) => `--syntax-${name}`);
    check(palette, pairs(syntax, ["--surface-sunken"]), 4.5);
    check(palette, [["--syntax-comment", "--surface-sunken"]], 3);
  });
}

test("the theme-color meta matches the page color of each palette", async () => {
  const { themeColorFor } = await import("@/lib/appearance");
  for (const palette of PALETTES) assert.equal(themeColorFor(palette), token("--orbit-bg", palette), palette);
});

test("an accent recolors the brand color but not charts or code", () => {
  for (const palette of PALETTES) {
    const charts = ACCENTS.map((accent) => token("--chart-1", palette, accent));
    const keywords = ACCENTS.map((accent) => token("--syntax-keyword", palette, accent));
    const suns = ACCENTS.map((accent) => token("--sun", palette, accent));
    assert.equal(new Set(charts).size, 1);
    assert.equal(new Set(keywords).size, 1);
    assert.equal(new Set(suns).size, ACCENTS.length);
  }
});
