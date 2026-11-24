import assert from "node:assert/strict";
import test from "node:test";
import { parseSandboxOwner } from "./owner.mjs";
import { containerSpec } from "./spec";

const owner = parseSandboxOwner("spec-owner");

const cases = [
  { language: "python", image: "python:3.13-slim@sha256:d0a9e379c0c588befb0e427db17ca9731751d281f32c6cb1a90a1277b680bdad", command: ["python3", "-u", "-"] },
  { language: "javascript", image: "node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d", command: ["node", "-"] },
] as const;

for (const { language, image, command } of cases) {
  test(`${language} receives the complete fixed container policy and no source in its options`, () => {
    const code = "untrusted source; $(touch /etc/x)";
    const spec = containerSpec({ language, code }, owner);
    assert.deepEqual(spec, {
      Image: image,
      Cmd: ["timeout", "-s", "KILL", "10", ...command],
      User: "65534:65534",
      NetworkDisabled: true,
      AttachStdin: true,
      AttachStdout: true,
      AttachStderr: true,
      OpenStdin: true,
      StdinOnce: true,
      Tty: false,
      Labels: { "orbit.sandbox": "true", "orbit.owner": "spec-owner" },
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: true,
        Tmpfs: { "/tmp": "rw,noexec,nosuid,size=64m" },
        Memory: 268435456,
        MemorySwap: 268435456,
        NanoCpus: 1000000000,
        PidsLimit: 64,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges"],
        AutoRemove: false,
        LogConfig: { Type: "none", Config: {} },
      },
    });
    assert.ok(!JSON.stringify(spec).includes(code));
    assert.deepEqual(spec, containerSpec({ language, code: "different code" }, owner));
  });
}
