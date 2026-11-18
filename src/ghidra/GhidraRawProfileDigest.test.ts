import { describe, expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { ghidraProducerIdentity } from "./GhidraProducerIdentity.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";

// A profile digest is the digest of its committed parameters; these tests pin
// the parameters (runtime selections and the producer identity) rather than a
// literal hash that every bridge or REA release would have to re-record.
const expectCommittedProfile = (
  profile: ReturnType<typeof createAnalysisProfile> | null | undefined,
): void => {
  if (profile == null) throw new Error("Expected an analysis profile");
  expect(profile.parameters).toMatchObject({
    producer: ghidraProducerIdentity(),
  });
  expect(profile.digest).toBe(
    createAnalysisProfile(profile.provider, profile.parameters).digest,
  );
};

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

describe("raw-binary analysis profile commitments", () => {
  it("commits the 6502 raw profile to the current shared policy", async () => {
    const ghidra = new GhidraProvider(configFor({}), silentLogger, {}, host);
    const resolved = await ghidra.resolveAnalysisProfile(raw("6502", "0x8001"));
    if (!resolved.ok) throw resolved.error;
    expectCommittedProfile(resolved.value.profile);
    expect(resolved.value.profile?.parameters).toMatchObject({
      target_format: "raw-binary",
      loader: "BinaryLoader",
      language_id: "6502:LE:16:default",
      language_selection: "caller-supplied",
      entry_point: "0x8001",
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
    expectCommittedProfile(resolved.value.profile);
    expect(resolved.value.profile?.parameters).toMatchObject({
      analyzer_preset: expect.any(String),
      analysis_options: {
        disabled_analyzers: ["Aggressive Instruction Finder"],
      },
    });
  });
});
