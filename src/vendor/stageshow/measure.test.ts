import assert from "node:assert/strict";
import test, { after, before } from "node:test";
import { layoutRectOf, targetRectOf } from "./measure";

type Style = {
  transform?: string;
  translate?: string;
  scale?: string;
  rotate?: string;
  transformOrigin?: string;
};

type Box = { left: number; top: number; width: number; height: number };

class FakeElement {
  parentElement: FakeElement | null = null;
  offsetParent: FakeElement | null = null;
  offsetLeft = 0;
  offsetTop = 0;
  offsetWidth = 0;
  offsetHeight = 0;
  scrollLeft = 0;
  scrollTop = 0;
  clientLeft = 0;
  clientTop = 0;
  style: Style = {};

  constructor(public box: Box = { left: 0, top: 0, width: 0, height: 0 }) {}

  getBoundingClientRect() {
    const { left, top, width, height } = this.box;
    return { left, top, width, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) };
  }

  contains(node: FakeElement | null) {
    for (let n = node; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
}

const realGetComputedStyle = globalThis.getComputedStyle;

const asElement = (el: FakeElement) => el as unknown as HTMLElement;

before(() => {
  globalThis.getComputedStyle = ((el: Element) => (el as unknown as FakeElement).style) as typeof getComputedStyle;
});

after(() => {
  if (realGetComputedStyle) globalThis.getComputedStyle = realGetComputedStyle;
  else delete (globalThis as { getComputedStyle?: typeof getComputedStyle }).getComputedStyle;
});

test("a target rect removes a scale set as its own CSS property", () => {
  const root = new FakeElement({ left: 0, top: 0, width: 500, height: 400 });
  root.offsetWidth = 500;
  const button = new FakeElement({ left: 35, top: 20, width: 50, height: 20 });
  button.parentElement = root;
  button.offsetWidth = 100;
  button.offsetHeight = 40;
  button.style = { transform: "none", scale: "0.5", transformOrigin: "50px 20px" };

  assert.deepEqual(targetRectOf(asElement(root), asElement(button), 1), { x: 10, y: 10, width: 100, height: 40 });
});

test("a layout rect takes the scroll off a scroller that is not positioned", () => {
  const root = new FakeElement({ left: 0, top: 0, width: 500, height: 400 });
  root.offsetWidth = 500;
  const camera = new FakeElement();
  camera.parentElement = root;
  camera.offsetParent = root;
  camera.style = { transform: "matrix(1, 0, 0, 1, 0, 0)" };
  const scroller = new FakeElement();
  scroller.parentElement = camera;
  scroller.offsetParent = camera;
  scroller.scrollLeft = 30;
  scroller.scrollTop = 10;
  const inner = new FakeElement();
  inner.parentElement = scroller;
  inner.offsetParent = camera;
  const button = new FakeElement();
  button.parentElement = inner;
  button.offsetParent = camera;
  button.offsetLeft = 100;
  button.offsetTop = 50;
  button.offsetWidth = 20;
  button.offsetHeight = 20;

  assert.deepEqual(layoutRectOf(asElement(root), asElement(button)), { x: 70, y: 40, width: 20, height: 20 });
});
