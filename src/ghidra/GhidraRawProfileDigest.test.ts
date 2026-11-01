import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";

// Digests commit to the current shared policy, including the instruction
// status, load-image relocation-symbol and procedure search revisions that
// prevent reuse of snapshots with earlier results.
const RAW_DIGESTS = {
  "6502": "fe1f7c8df86312021188d9a8a037cad5a479033e5886adf3b29ed1c5d2d4e5a6",
  "x86-disabled-analyzer":
    "8bb0a0ab463fb8bf46036cbcd1f128cf684e0181f30865baea6cfb44661fd282",
} as const;

const configFor = (environment: NodeJS.ProcessEnv) => {
  const parsed = parseConfig({ GHIDRA_INSTALL_DIR: "/ghidra", ...environment });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};

const raw = (architecture: "6502" | "x86", entryPoint: string): BinaryTarget =>
  ({
    path: "/tmp/raw.bin",
    sha256: "a".repeat(64),
    kind: "executable",
    format: "raw-binary",
    architecture,
    availableArchitectures: [architecture],
    entryPoint,
    entryPointSource: entryPoint,
  }) as unknown as BinaryTarget;

describe("raw-binary analysis profile digest", () => {
  it("commits the 6502 raw profile to the current shared policy", async () => {
    const ghidra = new GhidraProvider(configFor({}), silentLogger, {}, host);
    const resolved = await ghidra.resolveAnalysisProfile(raw("6502", "0x8001"));
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.digest).toBe(RAW_DIGESTS["6502"]);
    expect(resolved.value.profile?.parameters).toMatchObject({
      target_format: "raw-binary",
      loader: "BinaryLoader",
      language_id: "6502:LE:16:default",
      language_selection: "caller-supplied-v1",
      load_image_evidence: "independent-raw-mapping-context-v4",
      load_image_observations:
        "source-mappings-entry-context-relocation-symbol-v3",
      instruction_status: "unlisted-address-without-decode-v1",
      indirect_branch_inventory:
        "listing-computed-jumps-decompiler-comment-warnings-bounded-v2",
      analyzer_preset: "ghidra-default",
    });
  });

  it("keeps the disabled-analyzer raw digest and its analysis options", async () => {
    const ghidra = new GhidraProvider(
      configFor({
        REA_GHIDRA_DISABLED_ANALYZERS: "Aggressive Instruction Finder",
      }),
      silentLogger,
      {},
      host,
    );
    const resolved = await ghidra.resolveAnalysisProfile(raw("x86", "0x1000"));
    if (!resolved.ok) throw resolved.error;
    expect(resolved.value.profile?.digest).toBe(
      RAW_DIGESTS["x86-disabled-analyzer"],
    );
    expect(resolved.value.profile?.parameters).toMatchObject({
      analysis_options: {
        disabled_analyzers: ["Aggressive Instruction Finder"],
      },
    });
  });
});
