import assert from "node:assert/strict";
import test from "node:test";
import { cn } from "./utils";

test("cn keeps a type token next to a text color", () => {
  for (const size of ["text-prose", "text-input", "text-code", "text-meta", "text-h1", "text-h6", "text-2xs"]) {
    for (const color of ["text-foreground", "text-muted-foreground", "text-destructive"]) {
      assert.equal(cn(size, color), `${size} ${color}`);
      assert.equal(cn(color, size), `${color} ${size}`);
    }
  }
});

test("cn lets a later type token replace an earlier size", () => {
  assert.equal(cn("text-sm", "text-input"), "text-input");
  assert.equal(cn("text-prose", "text-meta"), "text-meta");
  assert.equal(cn("text-meta", "text-sm"), "text-sm");
});

test("cn treats font-reply as a font family and the width tokens as max widths", () => {
  assert.equal(cn("font-sans", "font-reply"), "font-reply");
  assert.equal(cn("font-reply", "font-medium"), "font-reply font-medium");
  assert.equal(cn("max-w-page", "max-w-chat"), "max-w-chat");
  assert.equal(cn("max-w-chat", "w-full"), "max-w-chat w-full");
});
