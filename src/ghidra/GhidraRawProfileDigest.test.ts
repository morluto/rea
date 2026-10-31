import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";

// Digests commit to the current shared policy, including the instruction status
// and inventory search revisions that prevent reuse of incompatible snapshots.
const RAW_DIGESTS = {
  "6502": "cdb139ac275b4ef15bb1ba83dfa3666e34939836a22b646552b8e624c5ef95e7",
  "x86-disabled-analyzer":
    "8e60d13f1dfd8116610b551e14ebb55b22396053bf5b3349dd8fb38fe5e2e6b7",
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
      instruction_status: "unlisted-address-without-decode-v1",
      inventory_search_projection: "provider-inventory-facts-v1",
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
      inventory_search_projection: "provider-inventory-facts-v1",
      analysis_options: {
        disabled_analyzers: ["Aggressive Instruction Finder"],
      },
    });
  });
});
