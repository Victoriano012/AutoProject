import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function fixture(work: (paths: { root: string; launcher: string; env: NodeJS.ProcessEnv; trace: string; ready: string }) => void) {
  const root = mkdtempSync(join(tmpdir(), "autoproject-launcher-"));
  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin);
  mkdirSync(join(root, "app/bin"), { recursive: true });
  mkdirSync(join(root, "app/node_modules/next"), { recursive: true });
  writeFileSync(join(root, "app/package.json"), "{}");
  const launcher = join(root, "app/bin/autoproject");
  copyFileSync(new URL("../bin/autoproject", import.meta.url), launcher);
  const command = (name: string, body: string) => writeFileSync(join(fakeBin, name), `#!/bin/bash\nset -eu\n${body}\n`, { mode: 0o755 });
  command("curl", '[ -f "$AUTOPROJECT_LAUNCH_TEST_DIR/ready" ]');
  command("npm", `printf '%s\\n' "$*" >> "$AUTOPROJECT_LAUNCH_TEST_DIR/trace"
if [ "$2" = build ] && [ "\u0024{AUTOPROJECT_LAUNCH_TEST_FAIL:-}" = build ]; then echo 'Simulated build error' >&2; exit 1; fi
if [ "$2" = start ] || [ "$2" = dev ]; then touch "$AUTOPROJECT_LAUNCH_TEST_DIR/ready"; fi`);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}`, AUTOPROJECT_STATE_DIR: join(root, "state"), AUTOPROJECT_LAUNCH_TEST_DIR: root };
  try { work({ root, launcher, env, trace: join(root, "trace"), ready: join(root, "ready") }); }
  finally { rmSync(root, { recursive: true, force: true }); }
}

test("launcher builds production, binds loopback, and resolves a symlinked checkout", () => {
  fixture(({ root, launcher, env, trace }) => {
    const link = join(root, "launch-link"); symlinkSync(launcher, link);
    const result = spawnSync("bash", [link, "--no-open", "--port", "4567"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /http:\/\/127\.0\.0\.1:4567/);
    assert.deepEqual(readFileSync(trace, "utf8").trim().split("\n"), [
      "run build", "run start -- --hostname 127.0.0.1 --port 4567",
    ]);
  });
});

test("launcher development mode skips the production build", () => {
  fixture(({ launcher, env, trace }) => {
    const result = spawnSync("bash", [launcher, "--dev", "--no-open"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(trace, "utf8").trim(), "run dev -- --hostname 127.0.0.1 --port 4123");
  });
});

test("launcher reuses a ready server and surfaces build failures", () => {
  fixture(({ launcher, env, ready, trace }) => {
    writeFileSync(ready, "ready");
    const reused = spawnSync("bash", [launcher, "--no-open"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(reused.status, 0, reused.stderr);
    assert.equal(existsSync(trace), false);
    rmSync(ready);
    const failed = spawnSync("bash", [launcher, "--no-open"], { env: { ...env, AUTOPROJECT_LAUNCH_TEST_FAIL: "build" }, encoding: "utf8", timeout: 10000 });
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /Simulated build error/);
    assert.match(failed.stderr, /Build failed.*server\.log/);
    assert.equal(readFileSync(trace, "utf8").trim(), "run build");
  });
});

test("launcher rejects invalid ports before invoking external services", () => {
  fixture(({ launcher, env, trace }) => {
    const result = spawnSync("bash", [launcher, "--port", "70000", "--no-open"], { env, encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /1 to 65535/);
    assert.equal(existsSync(trace), false);
  });
});
