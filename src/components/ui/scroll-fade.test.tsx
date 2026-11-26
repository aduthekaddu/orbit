import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ScrollFade } from "./scroll-fade";

function overlays(html: string) {
  return [...html.matchAll(/<div aria-hidden="true" class="([^"]*)"/g)].map((match) => match[1]);
}

test("each edge fade takes the container's corner radius, so a rounded well keeps its corners while a fade shows", () => {
  for (const axis of ["x", "y"] as const) {
    const html = renderToStaticMarkup(
      <ScrollFade axis={axis} fade="var(--surface-sunken)" className="rounded-md bg-surface-sunken">
        <p>content</p>
      </ScrollFade>,
    );
    const fades = overlays(html);
    assert.equal(fades.length, 2, axis);
    for (const classes of fades) assert.match(classes, /\brounded-\[inherit\]/, `${axis}: ${classes}`);
  }
});
