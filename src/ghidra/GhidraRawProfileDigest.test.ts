import { expect, it } from "vitest";

import { parseConfig } from "../config/parseConfig.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { silentLogger } from "../logger.js";
import { ghidraProfileInstallationHost as host } from "./GhidraInstallation.fixture.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { packagedSourcesDigest } from "../filesystem/ProducerIdentity.js";
import { PRODUCT_IDENTITY } from "../identity.js";
import { GHIDRA_BRIDGE_SOURCES } from "./GhidraBridgeSources.js";

const rawProfile = async (target: BinaryTarget, disabled?: string) => {
  const config = parseConfig({
    GHIDRA_INSTALL_DIR: "/ghidra",
    ...(disabled === undefined
      ? {}
      : { REA_GHIDRA_DISABLED_ANALYZERS: disabled }),
  });
  if (!config.ok) throw config.error;
  const provider = new GhidraProvider(config.value, silentLogger, {}, host);
  const resolved = await provider.resolveAnalysisProfile(target);
  if (!resolved.ok) throw resolved.error;
  if (resolved.value.profile === null)
    throw new Error("Missing raw analysis profile");
  return resolved.value.profile;
};

it("commits the raw entry and analyzer settings independently of the carrier", async () => {
  const target = {
    path: "/tmp/raw.bin",
    sha256: "a".repeat(64),
    kind: "executable",
    format: "raw-binary",
    architecture: "6502",
    availableArchitectures: ["6502"],
    entryPoint: "0x8001",
    entryPointSource: "0x8001",
  } as const satisfies BinaryTarget;
  const analyzer = "Aggressive Instruction Finder";
  const producer = {
    rea_version: PRODUCT_IDENTITY.packageVersion,
    sources_sha256: packagedSourcesDigest(
      new URL("../../bridge/ghidra/", import.meta.url),
      Object.values(GHIDRA_BRIDGE_SOURCES),
    ),
  };
  const standard = await rawProfile(target);
  const shifted = await rawProfile({
    ...target,
    entryPoint: "0x8002",
    entryPointSource: "0x8002",
  });
  const custom = await rawProfile(target, analyzer);
  expect(standard.parameters).toMatchObject({
    target_format: "raw-binary",
    loader: "BinaryLoader",
    language_id: "6502:LE:16:default",
    language_selection: "caller-supplied",
    entry_point: "0x8001",
    analyzer_preset: "ghidra-default",
    producer,
  });
  expect(shifted.parameters).toMatchObject({
    entry_point: "0x8002",
    analyzer_preset: "ghidra-default",
  });
  expect(custom.parameters).toMatchObject({
    entry_point: "0x8001",
    analyzer_preset: "ghidra-default+disabled:Aggressive Instruction Finder",
    analysis_options: { disabled_analyzers: [analyzer] },
    producer,
  });
  expect(shifted.digest).not.toBe(standard.digest);
  expect(custom.digest).not.toBe(standard.digest);
});
