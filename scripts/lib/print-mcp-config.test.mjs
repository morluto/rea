import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(
  new URL("../print-mcp-config.mjs", import.meta.url),
);
const print = (...args) =>
  spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });

test("print a startup config with explicit loader arguments", () => {
  const result = print(
    "--kind",
    "database",
    "example",
    "--loader-args",
    '["-l","a b"]',
  );
  assert.equal(result.status, 0, result.stderr);
  const { env } = JSON.parse(result.stdout).mcpServers.rea;
  assert.equal(env.HOPPER_TARGET_KIND, "database");
  assert.deepEqual(JSON.parse(env.HOPPER_LOADER_ARGS_JSON), ["-l", "a b"]);
});

test("invalid invocations cannot print an apparently usable config", () => {
  for (const args of [
    [],
    ["a", "b"],
    ["target", "--knid", "database"],
    ["target", "--kind"],
    ["target", "--kind", "unknown"],
    ["target", "--kind", "database", "--kind", "executable"],
    ["target", "--loader-args", "invalid"],
    ["target", "--loader-args", "[1]"],
    ["target", "--loader-args", '["a\\u0000b"]'],
  ]) {
    const result = print(...args);
    assert.notEqual(result.status, 0, JSON.stringify(args));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
  }
});

test("help describes the generator without emitting a registration", () => {
  const result = print("--help");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^Usage:/);
  assert.equal(result.stderr, "");
});
