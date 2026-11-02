import assert from "node:assert/strict";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ArtifactFrame } from "./artifact-frame";

test("artifact frame permits scripts and grants no other sandbox permissions", () => {
  const markup = renderToStaticMarkup(<ArtifactFrame document="<h1>Artifact</h1>" onError={() => {}} />);
  assert.equal(/\bsandbox="([^"]*)"/.exec(markup)?.[1], "allow-scripts");
  assert.match(markup, /srcDoc=|srcdoc=/);
});
