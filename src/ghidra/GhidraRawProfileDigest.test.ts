import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";

// Digests commit to the current shared policy, including the instruction
// status, load-image relocation-symbol, procedure search, byte-search and
// bit-field base-type and inventory-search revisions that prevent reuse of snapshots with earlier
// results.
const RAW_DIGESTS = {
  "6502": "4c9a3859c32099e951828ff0f842c8e39b4f2bd8560d5863198206c5b9e89df8",
  "x86-disabled-analyzer":
    "3236dd59aea782391ff90af5a5071941b12454d20fd266815c435e9e7631772b",
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
      inventory_search_projection: "provider-inventory-facts-v1",
      byte_search_boundary: "contiguous-eligible-initialized-blocks-v1",
      byte_search_coverage: "separate-loaded-overlays-v1",
      data_type_observations: "bit-field-base-and-lookup-v1",
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
      byte_search_coverage: "separate-loaded-overlays-v1",
      analysis_options: {
        disabled_analyzers: ["Aggressive Instruction Finder"],
      },
    });
  });
});
