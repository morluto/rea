#!/usr/bin/env node

/**
 * Real-engine verification for the Unicorn emulation provider (Phase 1).
 *
 * Runs actual Unicorn 2.1.2 emulation through the Python bridge — no
 * simulated provider — and checks the reported effects. Requires
 * REA_PWNTOOLS_PYTHON to point at a caller-supplied Python executable
 * carrying the pinned pwntools profile (pwntools 4.15.0, pyelftools 0.33,
 * unicorn 2.1.2). REA never installs Python or packages.
 *
 * Usage: npm run verify:unicorn
 * (builds first, then runs this script against dist/.)
 */

import { isAbsolute } from "node:path";

import { UnicornClient } from "../dist/unicorn/UnicornClient.js";
import { UNICORN_PYTHON_ENV_VAR } from "../dist/unicorn/UnicornRelease.js";

const pythonPath = process.env[UNICORN_PYTHON_ENV_VAR];
if (pythonPath === undefined || !isAbsolute(pythonPath)) {
  console.error(
    `Set ${UNICORN_PYTHON_ENV_VAR} to the absolute path of a caller-supplied Python executable with the pinned pwntools profile (unicorn 2.1.2).`,
  );
  process.exit(1);
}

const CODE = 0x1000000;
const STACK = 0x7f000000;

const failures = [];
const check = (name, condition, detail) => {
  if (condition) {
    console.log(`PASS ${name}`);
  } else {
    console.log(`FAIL ${name}: ${detail}`);
    failures.push(name);
  }
};

const run = async (client, name, input) => {
  const result = await client.execute("emulate_function", input);
  if (!result.ok) {
    check(name, false, `client error: ${result.error.message}`);
    return null;
  }
  return result.value.result;
};

const client = new UnicornClient({ [UNICORN_PYTHON_ENV_VAR]: pythonPath });

// 1. add: mov eax, edi; add eax, esi; ret — 40 + 2 = 42.
const add = await run(client, "add returns 42", {
  architecture: "x86_64",
  function_bytes: "89f801f0c3",
  code_address: CODE,
  registers: { rdi: 40, rsi: 2 },
  stack_address: STACK,
  stack_size: 65536,
});
if (add !== null) {
  check("add stop_reason", add.stop_reason === "returned", add.stop_reason);
  check("add return_value", add.return_value === 42, add.return_value);
}

// 2. buffer write: mov dword [rdi], 0x11223344; ret — exact memory diff.
const written = await run(client, "buffer write reports exact diff", {
  architecture: "x86_64",
  function_bytes: "c70744332211c3",
  code_address: CODE,
  registers: { rdi: 0x2000000, rax: 0 },
  memory: [{ address: 0x2000000, bytes: "00000000" }],
  stack_address: STACK,
  stack_size: 65536,
});
if (written !== null) {
  check(
    "buffer write stop_reason",
    written.stop_reason === "returned",
    written.stop_reason,
  );
  check(
    "buffer write diff",
    written.memory_writes.length === 1 &&
      written.memory_writes[0].address === 0x2000000 &&
      written.memory_writes[0].before === "00000000" &&
      written.memory_writes[0].after === "44332211",
    JSON.stringify(written.memory_writes),
  );
}

// 3. stubbed import call: call 0x3000000; ret — stub returns 7, never executes.
const stubbed = await run(client, "stubbed import call returns stub value", {
  architecture: "x86_64",
  function_bytes: "e8fbffff01c3",
  code_address: CODE,
  registers: { rdi: 40 },
  stack_address: STACK,
  stack_size: 65536,
  stubs: { "0x3000000": 7 },
});
if (stubbed !== null) {
  check(
    "stubbed stop_reason",
    stubbed.stop_reason === "returned",
    stubbed.stop_reason,
  );
  check(
    "stubbed return_value",
    stubbed.return_value === 7,
    stubbed.return_value,
  );
  check(
    "stubbed call recorded",
    stubbed.calls_hit.length === 1 &&
      stubbed.calls_hit[0].kind === "import" &&
      stubbed.calls_hit[0].address === 0x3000000 &&
      stubbed.calls_hit[0].stubbed === true &&
      stubbed.calls_hit[0].returned === 7,
    JSON.stringify(stubbed.calls_hit),
  );
}

// 4. unmapped read: mov rax, [rdi]; ret — rdi points nowhere declared.
const unmapped = await run(client, "unmapped read stops, never crashes", {
  architecture: "x86_64",
  function_bytes: "488b07c3",
  code_address: CODE,
  registers: { rdi: 0x4000000 },
  stack_address: STACK,
  stack_size: 65536,
});
if (unmapped !== null) {
  check(
    "unmapped stop_reason",
    unmapped.stop_reason === "unmapped_access",
    unmapped.stop_reason,
  );
  check(
    "unmapped return_value",
    unmapped.return_value === null,
    unmapped.return_value,
  );
}

if (failures.length > 0) {
  console.error(`verify-unicorn: ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log("verify-unicorn: all checks passed");
