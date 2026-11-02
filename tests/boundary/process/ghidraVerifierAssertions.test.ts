import { expect } from "vitest";

import { processTest } from "../../support/process/processFixture.js";

processTest(
  "Ghidra verifier session assertions fail within the caller's synchronous error boundary",
  async ({ processes }) => {
    const assertionsUrl = new URL(
      "../../../scripts/verify-real-ghidra-assertions.mjs",
      import.meta.url,
    ).href;
    const valuesUrl = new URL(
      "../../../dist/ghidra/GhidraSessionValues.js",
      import.meta.url,
    ).href;
    const policyUrl = new URL(
      "../../../dist/ghidra/GhidraReleasePolicy.js",
      import.meta.url,
    ).href;
    // Authored handshake facts exercise the verifier, not a running provider.
    const source = `
    import assert from "node:assert/strict";
    import { assertSession } from ${JSON.stringify(assertionsUrl)};
    import { GHIDRA_SESSION_CAPABILITIES } from ${JSON.stringify(valuesUrl)};
    import { SUPPORTED_GHIDRA_VERSION } from ${JSON.stringify(policyUrl)};

    const profileDigest = "a".repeat(64);
    const targetSha256 = "b".repeat(64);
    const session = {
      name: "REA Ghidra bridge",
      run_id: "d6fcbb66-e829-4ff6-a535-0035aec63139",
      profile_digest: profileDigest,
      provider: { id: "ghidra", version: SUPPORTED_GHIDRA_VERSION },
      read_only: false,
      analysis_complete: true,
      analysis_timed_out: false,
      capabilities: [...GHIDRA_SESSION_CAPABILITIES],
      target: {
        name: "fixture.bin",
        language_id: "x86:LE:64:default",
        compiler_spec_id: "gcc",
        image_base: "0x401000",
        default_address_space: "ram",
        sha256: targetSha256,
      },
    };

    assert.doesNotThrow(() => assertSession(session, profileDigest, targetSha256));
    assert.throws(
      () => assertSession(
        { ...session, analysis_complete: false }, profileDigest, targetSha256,
      ),
      /Ghidra session commitment drifted/,
    );
    assert.throws(
      () => assertSession(session, profileDigest, "c".repeat(64)),
      /Ghidra session commitment drifted/,
    );
  `;
    const result = await processes.run(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { timeoutMs: 10_000 },
    );
    expect(result.signal, result.stderr).toBeNull();
    expect(result.exitCode, result.stderr).toBe(0);
  },
);

processTest(
  "Ghidra cleanup rejects unreadable paths and accepts only confirmed absence",
  async ({ processes }) => {
    const assertionsUrl = new URL(
      "../../../scripts/verify-real-ghidra-assertions.mjs",
      import.meta.url,
    ).href;
    const source = `
      import assert from "node:assert/strict";
      import { createRequire, syncBuiltinESMExports } from "node:module";
      const fs = createRequire(import.meta.url)("node:fs/promises");
      const { assertCleanup } = await import(${JSON.stringify(assertionsUrl)});
      const root = await fs.mkdtemp((await import("node:os")).tmpdir() + "/rea-ghidra-cleanup-test-");
      try {
        const dangling = root + "/dangling";
        if (process.platform !== "win32") {
          await fs.symlink(root + "/missing-target", dangling);
          await assert.rejects(assertCleanup({ runtime_root: dangling }), /Ghidra cleanup left runtime_root/);
        }
      } finally { await fs.rm(root, { recursive: true, force: true }); }
      let result = "exists";
      fs.lstat = async () => {
        if (result === "exists") return;
        const error = new Error(result);
        error.code = result;
        throw error;
      };
      syncBuiltinESMExports();
      const coordinates = { runtime_root: "/owned-runtime" };
      await assert.rejects(assertCleanup(coordinates), /Ghidra cleanup left runtime_root/);
      result = "ENOENT";
      await assertCleanup(coordinates);
      result = "EACCES";
      await assert.rejects(assertCleanup(coordinates), { code: "EACCES" });
    `;
    const result = await processes.run(
      process.execPath,
      ["--input-type=module", "--eval", source],
      { timeoutMs: 10_000 },
    );
    expect(result.signal, result.stderr).toBeNull();
    expect(result.exitCode, result.stderr).toBe(0);
  },
);
