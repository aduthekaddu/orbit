import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";

const script = path.join(process.cwd(), "scripts/deploy-wizard.sh");
const token = `dummy-${"a".repeat(60)}`;
let directory: string;
let stubs: string;

function stub(name: string, body: string) {
  const file = path.join(stubs, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
}

// Answers in prompt order: banner, token, token saved, public URL, route saved, application saved, policy saved, start the tunnel, finish.
function wizard(options: { envFile: string; start?: boolean; curl?: string }) {
  const answers = ["", token, "", "", "", "", "", options.start ? "y" : "n", ""].join("\n") + "\n";
  const result = spawnSync("bash", [script], {
    input: answers,
    encoding: "utf8",
    env: { ...process.env, ENV_FILE: options.envFile, PATH: `${stubs}:${process.env.PATH}`, STUB_CURL: options.curl ?? "" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function mode(file: string) {
  return fs.statSync(file).mode & 0o777;
}

before(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "orbit-deploy-wizard-"));
  stubs = path.join(directory, "bin");
  fs.mkdirSync(stubs);
  stub("docker", 'if [ "$2" = "logs" ]; then echo "Registered tunnel connection"; fi');
  stub("curl", 'printf "%s" "$STUB_CURL"');
  for (const opener of ["xdg-open", "wslview", "explorer.exe", "open"]) stub(opener, "exit 0");
});

after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("the wizard creates .env readable only by its owner", () => {
  const envFile = path.join(directory, "new.env");
  const result = wizard({ envFile });
  assert.equal(result.status, 0, result.output);
  assert.equal(mode(envFile), 0o600);
  assert.match(fs.readFileSync(envFile, "utf8"), new RegExp(`^CLOUDFLARE_TUNNEL_TOKEN='${token}'$`, "m"));
});

for (const existing of [0o644, 0o664, 0o666]) {
  test(`the wizard locks an existing ${existing.toString(8)} .env to its owner and keeps its other lines`, () => {
    const envFile = path.join(directory, `existing-${existing.toString(8)}.env`);
    fs.writeFileSync(envFile, "KEEP=1\n");
    fs.chmodSync(envFile, existing);
    const result = wizard({ envFile });
    assert.equal(result.status, 0, result.output);
    assert.equal(mode(envFile), 0o600);
    const text = fs.readFileSync(envFile, "utf8");
    assert.match(text, /^KEEP=1$/m);
    assert.match(text, new RegExp(`^CLOUDFLARE_TUNNEL_TOKEN='${token}'$`, "m"));
    assert.equal(result.output.includes(token), false, "the token reached the output");
  });
}

const access = "Access is in front of Orbit";
const redirects: Array<[string, string, boolean]> = [
  ["a team subdomain", "302 https://team.cloudflareaccess.com/cdn-cgi/access/login/orbit", true],
  ["the bare domain", "302 https://cloudflareaccess.com/login", true],
  ["a host with a port", "302 https://team.cloudflareaccess.com:8443/login", true],
  ["a lookalike that starts with the domain", "302 https://cloudflareaccess.com.attacker.invalid/login", false],
  ["a lookalike that ends with the domain", "302 https://evilcloudflareaccess.com/login", false],
  ["the domain in the path", "302 https://attacker.invalid/cloudflareaccess.com", false],
  ["the domain in the query", "302 https://attacker.invalid/login?next=https://team.cloudflareaccess.com/", false],
  ["the domain as user info", "302 https://team.cloudflareaccess.com@attacker.invalid/login", false],
  ["a backslash before the user info", "302 https://attacker.invalid\\@team.cloudflareaccess.com/login", false],
  ["plain http", "302 http://team.cloudflareaccess.com/login", false],
  ["a 200 with no redirect", "200 ", false],
  ["a 301 to the domain", "301 https://team.cloudflareaccess.com/login", false],
  ["no answer", "", false],
];

for (const [name, curl, accepted] of redirects) {
  test(`the Access check ${accepted ? "accepts" : "rejects"} ${name}`, () => {
    const result = wizard({ envFile: path.join(directory, "redirect.env"), start: true, curl });
    assert.equal(result.status, 0, result.output);
    assert.equal(result.output.includes(access), accepted, result.output);
    assert.equal(result.output.includes("Expected 302 to a cloudflareaccess.com address"), !accepted, result.output);
  });
}
