// End-to-end verification for REA persistent LLDB debugger sessions on macOS arm64.
// Contributed by Hardik Shah <hardik05@gmail.com> (https://fuzzing.in, @hardik05).

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { VerifierFixture } from "./lib/verifier-fixture.mjs";
import { LldbSessionManager } from "../src/lldb/LldbSessionManager.js";

const exec = promisify(execFile);

if (process.platform !== "darwin") {
  console.log(
    "[-] Native LLDB session verification requires macOS Apple Silicon (Darwin).",
  );
  process.exit(0);
}

const fixture = await VerifierFixture.open({ prefix: "rea-lldb-e2e-" });
const tempDir = fixture.path;
const testSource = join(tempDir, "target.c");
const targetBinary = join(tempDir, "target");

const cCode = `
#include <stdio.h>

int compute_magic(int a, int b) {
    int sum = a + b;
    return sum * 2;
}

int main(int argc, char **argv) {
    printf("Starting test binary...\\n");
    int val = compute_magic(21, 21);
    printf("Calculated magic: %d\\n", val);
    return 0;
}
`;

let manager = null;

try {
  await writeFile(testSource, cCode, "utf8");

  // Locate matching clang and SDK
  let clangPath = "clang";
  let sdkPath = "";

  const candidatePairs = [
    {
      clang:
        "/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
      sdk: "/Applications/Xcode.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    },
    {
      clang:
        "/Volumes/MyData/Applications/Xcode-26.6.0.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/bin/clang",
      sdk: "/Volumes/MyData/Applications/Xcode-26.6.0.app/Contents/Developer/Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk",
    },
  ];

  for (const c of candidatePairs) {
    if (existsSync(c.clang) && existsSync(c.sdk)) {
      clangPath = c.clang;
      sdkPath = c.sdk;
      break;
    }
  }

  if (!sdkPath) {
    try {
      const { stdout } = await exec("xcrun", ["-find", "clang"]);
      if (stdout?.trim()) clangPath = stdout.trim();
    } catch {}
    try {
      const { stdout } = await exec("xcrun", ["--show-sdk-path"]);
      if (stdout?.trim()) sdkPath = stdout.trim();
    } catch {}
  }

  const compileArgs = [];
  if (sdkPath) {
    compileArgs.push("-isysroot", sdkPath);
  }
  compileArgs.push("-g", "-O0", testSource, "-o", targetBinary);

  await exec(clangPath, compileArgs);
  await exec("codesign", ["-s", "-", "-v", "-f", targetBinary]);

  console.log("=== Testing Native REA LLDB Session Manager ===");
  manager = new LldbSessionManager();

  // 1. Start Session with initial breakpoint on compute_magic
  console.log("\n[1] Starting LLDB session with target:", targetBinary);
  const startResult = await manager.start(undefined, {
    path: targetBinary,
    breakpoints: ["compute_magic"],
    stop_at_entry: true,
  });

  assert.equal(
    startResult.ok,
    true,
    `Failed to start session: ${JSON.stringify(startResult)}`,
  );
  const { session_id, pid, state } = startResult.value;
  console.log(
    `[+] LLDB Session started! ID: ${session_id}, PID: ${pid}, State: ${state}`,
  );
  assert.ok(session_id, "Session ID should be defined");
  assert.ok(pid, "Target PID should be assigned");

  // 2. Query Session Status
  console.log("\n[2] Checking initial session status...");
  const statusBefore = await manager.status(session_id);
  console.log("[+] Status:", statusBefore);
  assert.equal(statusBefore?.state, "ready");

  // 3. Continue to the breakpoint at compute_magic
  console.log("\n[3] Continuing to breakpoint at 'compute_magic'...");
  const contResult = await manager.execute(session_id, "continue");
  assert.equal(
    contResult.ok,
    true,
    `Continue failed: ${JSON.stringify(contResult)}`,
  );
  console.log("[+] Breakpoint hit output:\n" + contResult.value.result.output);
  assert.ok(
    contResult.value.result.output.includes("compute_magic") ||
      contResult.value.result.output.includes("stop reason = breakpoint"),
    "Target should have stopped at breakpoint",
  );

  // 4. Read ARM64 argument registers ($x0, $x1)
  console.log("\n[4] Reading ARM64 argument registers ($x0, $x1)...");
  const regResult = await manager.execute(session_id, "register read x0 x1");
  assert.equal(regResult.ok, true);
  console.log("[+] Registers:\n" + regResult.value.result.output);
  assert.ok(
    regResult.value.result.output.includes("x0"),
    "Output should contain x0",
  );

  // 5. Inspect Call Stack Backtrace
  console.log("\n[5] Retaining Thread Call-Stack Backtrace...");
  const btResult = await manager.execute(session_id, "thread backtrace");
  assert.equal(btResult.ok, true);
  console.log("[+] Backtrace:\n" + btResult.value.result.output);
  assert.ok(
    btResult.value.result.output.includes("compute_magic"),
    "Frame should include compute_magic",
  );

  // 6. Resume execution to process completion
  console.log("\n[6] Resuming execution until process exit...");
  const exitResult = await manager.execute(session_id, "continue");
  assert.equal(exitResult.ok, true);
  console.log("[+] Exit output:\n" + exitResult.value.result.output);

  // 7. Verify Evidence Construction
  console.log("\n[7] Verifying Evidence object produced by REA...");
  const evidence = exitResult.value.evidence;
  console.log("[+] Evidence ID:", evidence.evidence_id);
  console.log("[+] Provider:", evidence.provider);
  console.log("[+] Predicate:", evidence.predicate_type);
  assert.equal(evidence.provider.id, "apple.lldb");
  assert.equal(evidence.predicate_type, "rea.debugger.console-observation");
  assert.equal(evidence.subject.identity.kind, "session");
  assert.equal(evidence.subject.identity.session_kind, "lldb");
  assert.equal(evidence.subject.identity.target.kind, "file");
  assert.ok(
    evidence.subject.identity.target.sha256,
    "Target should have sha256",
  );
  assert.ok(
    evidence.parameters.launch_provenance,
    "Evidence should have launch_provenance",
  );
  assert.equal(
    evidence.parameters.launch_provenance.caller_selected_path,
    targetBinary,
  );

  // 8. Close LLDB Session for exited target
  console.log("\n[8] Closing LLDB session for exited target...");
  const closeResult = await manager.close(session_id);
  assert.equal(closeResult.ok, true);
  console.log("[+] Close Result:", closeResult.value);
  assert.equal(closeResult.value.target_state, "exited");

  // 9. Live-target cleanup regression: verify live process is terminated cleanly
  console.log("\n[9] Testing live-target cleanup on running session...");
  const liveStart = await manager.start(undefined, {
    path: targetBinary,
    stop_at_entry: true,
  });
  assert.equal(liveStart.ok, true);
  const liveClose = await manager.close(liveStart.value.session_id);
  assert.equal(liveClose.ok, true);
  console.log("[+] Live Target Close Result:", liveClose.value);
  assert.equal(liveClose.value.target_state, "terminated");

  console.log("\n>>> ALL LLDB SESSION E2E TESTS PASSED SUCCESSFULLY! <<<\n");
} finally {
  if (manager) {
    await manager.closeAll().catch(() => undefined);
  }
  if (fixture) {
    await fixture.release().catch(() => undefined);
  }
}
