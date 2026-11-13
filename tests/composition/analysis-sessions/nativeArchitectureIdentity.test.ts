import { expect, it } from "vitest";
import type { BinaryTarget } from "../../../src/domain/binaryTargetTypes.js";
import { createAnalysisProfile } from "../../../src/domain/analysisProfile.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { createEvidenceBundle } from "../../../src/domain/evidenceBundle.js";
import {
  createAnalysisSnapshotEntry,
  parseAnalysisSnapshot,
  serializeAnalysisSnapshot,
  snapshotBinding,
  snapshotTarget,
  snapshotMatchesProfile,
} from "../../../src/domain/analysisSnapshot.js";
import { sessionOutputSchemas } from "../../../src/contracts/toolOutputSchemaGroups.js";

const provider = { id: "ghidra", name: "Ghidra", version: "12.1.4" };
const commonTarget = {
  path: "/source-owned.elf",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
} as const;
const cases = [
  {
    architecture: "mips",
    target: {
      ...commonTarget,
      architecture: "mips",
      availableArchitectures: ["mips"],
      mips: { elfClass: 32, byteOrder: "little", type: 2, flags: 0x70001001 },
    },
    profile: {
      mips_elf: {
        elf_class: 32,
        byte_order: "little",
        type: 2,
        flags: 0x70001001,
      },
    },
    changed: {
      mips_elf: {
        elf_class: 32,
        byte_order: "big",
        type: 2,
        flags: 0x70001001,
      },
    },
    observation: { address: "0x20150", value: "rea_mips_entry" },
  },
  {
    architecture: "powerpc",
    target: {
      ...commonTarget,
      architecture: "powerpc",
      availableArchitectures: ["powerpc"],
      powerpc: { elfClass: 32, byteOrder: "big", type: 2, flags: 0 },
    },
    profile: {
      powerpc_elf: { elf_class: 32, byte_order: "big", type: 2, flags: 0 },
    },
    changed: {
      powerpc_elf: {
        elf_class: 32,
        byte_order: "big",
        type: 2,
        flags: 0x00010000,
      },
    },
    observation: { address: "0x100101b0", value: "rea_ppc_entry" },
  },
] as const satisfies readonly {
  architecture: string;
  target: BinaryTarget;
  profile: object;
  changed: object;
  observation: { address: string; value: string };
}[];

it.each(cases)(
  "round-trips $architecture identity through Evidence and snapshots",
  ({
    architecture,
    target,
    observation,
    profile: facts,
    changed: changedFacts,
  }) => {
    const result = [observation];
    const profile = createAnalysisProfile(provider, facts);
    const parameters = {};
    const evidence = createEvidence(target, provider, {
      operation: "list_procedures",
      parameters,
      result,
      analysisProfile: profile,
    });
    const binding = snapshotBinding(profile);
    const entry = createAnalysisSnapshotEntry({
      target: snapshotTarget(target),
      binding,
      operation: "list_procedures",
      parameters,
      execution: {
        result,
        rawResult: null,
        provider,
        analysisProfile: profile,
        limitations: [],
        locations: [],
        subject: target,
      },
    });
    const snapshot = {
      target: snapshotTarget(target),
      binding,
      entries: [entry],
      workflow_entries: [],
      evidence_bundle: createEvidenceBundle([evidence]),
    };
    const restored = parseAnalysisSnapshot(
      JSON.parse(serializeAnalysisSnapshot(snapshot)),
    );
    expect(restored.target.architecture).toBe(architecture);
    expect(restored.evidence_bundle.records[0]?.subject?.architecture).toBe(
      architecture,
    );
    expect(restored.entries[0]?.execution.subject?.architecture).toBe(
      architecture,
    );
    expect(
      sessionOutputSchemas.open_binary.parse({ result: target }).result
        .architecture,
    ).toBe(architecture);
    expect(() =>
      parseEvidence({
        ...evidence,
        subject: { ...evidence.subject, architecture: "x86" },
      }),
    ).toThrow("semantic identifier");
    const changed = createAnalysisProfile(provider, changedFacts);
    expect(snapshotMatchesProfile(binding, changed)).toBe(false);
  },
);
