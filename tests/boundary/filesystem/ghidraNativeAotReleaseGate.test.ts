import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

import {
  SUPPORTED_GHIDRA_FLOOR_VERSION,
  SUPPORTED_GHIDRA_VERSION,
} from "../../../src/ghidra/GhidraReleasePolicy.js";

const execute = promisify(execFile);

/**
 * Drives the NativeAOT build's own admission gate.
 *
 * The build runs end to end at import, so the gate is observed by importing it
 * against a synthetic installation: a version the lane admits proceeds past the
 * gate and fails later on the deliberately absent source tree, while a version
 * it rejects fails with the gate's own message. Asserting on that difference is
 * what keeps these cases honest — calling `ghidraReleaseAccepted` directly would
 * stay green if the build went back to a hard-coded `12.1.x` check.
 */
const admission = async (
  version: string,
): Promise<{ admitted: boolean; message: string }> => {
  const root = await mkdtemp(join(tmpdir(), "rea-nativeaot-gate-"));
  const install = join(root, "ghidra");
  await mkdir(join(install, "Ghidra"), { recursive: true });
  await writeFile(
    join(install, "Ghidra/application.properties"),
    `application.version=${version}\napplication.java.min=25\n`,
  );
  const probe = join(root, "probe.mjs");
  await writeFile(
    probe,
    [
      "const build = " +
        JSON.stringify(resolve("scripts/build-ghidra-nativeaot.mjs")) +
        ";",
      "try { await import(build); console.log('ADMITTED'); }",
      "catch (error) {",
      "  console.log('REJECTED:' + String(error.message).split('\\n')[0]);",
      "}",
    ].join("\n"),
  );
  const { stdout } = await execute(process.execPath, [probe], {
    env: {
      ...process.env,
      GHIDRA_INSTALL_DIR: install,
      REA_NATIVEAOT_SOURCE: join(root, "absent-source-tree"),
    },
    timeout: 60_000,
  });
  const line = stdout.trim().split("\n").at(-1) ?? "";
  return {
    admitted: line === "ADMITTED" || !line.includes("accepts Ghidra"),
    message: line,
  };
};

const GATE_MESSAGE = /NativeAOT build lane accepts Ghidra/u;

describe("NativeAOT build admission", () => {
  it("admits the verified release", async () => {
    const { message } = await admission(SUPPORTED_GHIDRA_VERSION);
    expect(message).not.toMatch(GATE_MESSAGE);
  });

  it("admits the accepted floor", async () => {
    const { message } = await admission(`${SUPPORTED_GHIDRA_FLOOR_VERSION}.4`);
    expect(message).not.toMatch(GATE_MESSAGE);
  });

  it("admits a later release on the same major", async () => {
    const { message } = await admission("12.3");
    expect(message).not.toMatch(GATE_MESSAGE);
  });

  it.each(["12.0.4", "11.4", "13.0"])(
    "rejects %s at the gate",
    async (version) => {
      const { message } = await admission(version);
      expect(message).toMatch(GATE_MESSAGE);
      expect(message).toContain(version);
    },
  );
});
