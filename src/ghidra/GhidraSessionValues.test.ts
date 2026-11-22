import { describe, expect, it } from "vitest";

import { FAKE_GHIDRA_CAPABILITIES } from "../../tests/fixtures/fakeGhidraReplies.mjs";
import { parseGhidraSessionInfo } from "./GhidraSessionValues.js";

const expected = {
  runId: "d6fcbb66-e829-4ff6-a535-0035aec63139",
  providerVersion: "12.1.4",
  profileDigest: "a".repeat(64),
  targetSha256: "b".repeat(64),
  expectedLanguageId: "x86:LE:16:Real Mode",
  expectedCompilerSpecId: "default",
};
const session = () => ({
  name: "REA Ghidra bridge",
  run_id: expected.runId,
  profile_digest: expected.profileDigest,
  provider: { id: "ghidra", version: expected.providerVersion },
  read_only: false,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...FAKE_GHIDRA_CAPABILITIES],
  target: {
    name: "legacy.exe",
    language_id: expected.expectedLanguageId,
    compiler_spec_id: expected.expectedCompilerSpecId,
    image_base: "0x0",
    default_address_space: "ram",
    sha256: expected.targetSha256,
  },
});

const refuseHandshake = (
  value: Parameters<typeof parseGhidraSessionInfo>[0],
  commitment: Parameters<typeof parseGhidraSessionInfo>[1] = expected,
) => {
  expect(parseGhidraSessionInfo(value, commitment)).toMatchObject({
    ok: false,
    error: { _tag: "GhidraAdmissionError", code: "handshake_identity" },
  });
};

it("checks admitted language, compiler, and image base independently", () => {
  const value = session();
  const commitment = { ...expected, expectedImageBase: "0x0" };
  const parsed = parseGhidraSessionInfo(value, commitment);
  if (!parsed.ok) throw parsed.error;
  expect(parsed.value.target).toMatchObject({
    language_id: "x86:LE:16:Real Mode",
    compiler_spec_id: "default",
    image_base: "0x0",
  });
  // Each variation keeps run, target and profile identity intact.
  for (const changed of [
    { language_id: "x86:LE:32:default" },
    { compiler_spec_id: "windows" },
    { image_base: "0x10000" },
  ])
    refuseHandshake(
      { ...value, target: { ...value.target, ...changed } },
      commitment,
    );
});

describe("Ghidra PDB observations", () => {
  const pdb = {
    file: "C:\\build\\fixture.pdb",
    guid: "01234567-89AB-CDEF-0123-456789ABCDEF",
    age: "a",
    signature: null,
    version: "RSDS",
    loaded: false,
  };
  it.each([
    ["reported identity", pdb],
    [
      "explicit unknown attributes",
      {
        file: null,
        guid: null,
        age: null,
        signature: null,
        version: null,
        loaded: null,
      },
    ],
  ] as const)("preserves %s", (_name, attributes) => {
    const parsed = parseGhidraSessionInfo(
      { ...session(), pdb: attributes },
      expected,
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.pdb).toEqual(attributes);
  });
  it.each([
    { ...pdb, loaded: "false" },
    { ...pdb, age: 1 },
    {
      guid: pdb.guid,
      age: pdb.age,
      signature: null,
      version: "RSDS",
      loaded: false,
    },
    { ...pdb, matched: true },
  ])("rejects malformed PDB reports", (report) => {
    expect(
      parseGhidraSessionInfo({ ...session(), pdb: report }, expected).ok,
    ).toBe(false);
  });
});

describe("Ghidra MIPS soft-float storage report", () => {
  const valid = {
    policy: "o32-soft-float-prototype-v1",
    functions: 2,
    definitions: 1,
  };
  it("accepts the exact committed policy outcome", () => {
    const parsed = parseGhidraSessionInfo(
      { ...session(), mips_soft_float_storage: valid },
      expected,
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.mips_soft_float_storage).toEqual(valid);
  });
  it.each([
    [
      "the superseded storage policy",
      { ...valid, policy: "o32-integer-registers-v1" },
    ],
    ["a negative count", { ...valid, definitions: -1 }],
    ["a fractional count", { ...valid, functions: 1.5 }],
    ["a missing count", { policy: valid.policy, functions: 2 }],
    ["an undeclared field", { ...valid, skipped: 0 }],
    ["a non-object report", "functions"],
  ])("rejects %s", (_label, report) => {
    expect(
      parseGhidraSessionInfo(
        { ...session(), mips_soft_float_storage: report },
        expected,
      ).ok,
    ).toBe(false);
  });
});

describe("Ghidra RISC-V calling-convention report", () => {
  const valid = {
    policy: "ilp32-prototype-v1",
    functions: 11,
    definitions: 11,
  };
  const single = {
    policy: "ilp32f-prototype-v1",
    functions: 17,
    definitions: 16,
  };
  const refused = {
    policy: "ilp32f-prototype-v1",
    refused: "1 signature passes rea_riscv_abi_half (_Float16).",
  };
  it.each([
    ["the ilp32 outcome", valid],
    ["the ilp32f outcome", single],
    ["an ilp32f refusal", refused],
    // Either policy refuses functions compiled from another language.
    ["an ilp32 refusal", { ...refused, policy: valid.policy }],
  ])("accepts %s exactly", (_label, report) => {
    const parsed = parseGhidraSessionInfo(
      { ...session(), riscv_calling_convention: report },
      expected,
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.riscv_calling_convention).toEqual(report);
  });
  it.each([
    ["the MIPS policy", { ...valid, policy: "o32-soft-float-prototype-v1" }],
    ["a negative count", { ...valid, definitions: -1 }],
    ["a fractional count", { ...valid, functions: 1.5 }],
    ["a missing count", { policy: valid.policy, functions: 2 }],
    ["an undeclared field", { ...valid, prototype: "__rea_ilp32" }],
    ["a non-object report", "ilp32-prototype-v1"],
    ["a custom-storage count", { ...single, custom_storage: 1 }],
    [
      "a refusal of an unknown policy",
      { ...refused, policy: "lp64-prototype-v1" },
    ],
    ["a refusal with counts", { ...refused, functions: 1 }],
    ["an empty refusal", { ...refused, refused: "" }],
    ["an unbounded refusal", { ...refused, refused: "x".repeat(2049) }],
  ])("rejects %s", (_label, report) => {
    expect(
      parseGhidraSessionInfo(
        { ...session(), riscv_calling_convention: report },
        expected,
      ).ok,
    ).toBe(false);
  });
});

describe("Ghidra disabled analyzer report", () => {
  const valid = {
    format: "rea-ghidra-disabled-analyzers-v1",
    analyzers: [
      { name: "Decompiler Switch Analysis", status: "disabled" },
      { name: "Objective-C Message Analyzer", status: "not_applicable" },
    ],
  };
  it("accepts disabled and not-applicable outcomes in configured order", () => {
    const parsed = parseGhidraSessionInfo(
      { ...session(), disabled_analyzers: valid },
      expected,
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.disabled_analyzers).toEqual(valid);
  });
  it.each([
    [
      "an unknown analyzer reported as accepted",
      {
        ...valid,
        analyzers: [{ name: "REA Unknown Analyzer", status: "unknown" }],
      },
    ],
    ["an empty outcome list", { ...valid, analyzers: [] }],
    ["another report format", { ...valid, format: "rea-ghidra-seeds-v1" }],
    ["an undeclared field", { ...valid, skipped: [] }],
  ])("rejects %s", (_label, report) => {
    expect(
      parseGhidraSessionInfo(
        { ...session(), disabled_analyzers: report },
        expected,
      ).ok,
    ).toBe(false);
  });
});

const databaseEdits = [
  "annotate_native_function",
  "set_address_name",
  "set_addresses_names",
] as const;

const readOnlySession = () => ({
  ...session(),
  read_only: true,
  capabilities: FAKE_GHIDRA_CAPABILITIES.filter(
    (method) => !databaseEdits.some((edit) => edit === method),
  ),
});

it("refuses duplicate capabilities with either matching or excess cardinality", () => {
  const value = session();
  refuseHandshake({
    ...value,
    capabilities: value.capabilities.map((method) =>
      method === "annotate_native_function" ? "ping" : method,
    ),
  });
  refuseHandshake({ ...value, capabilities: [...value.capabilities, "ping"] });
});

it.each([false, true])(
  "admits only read-only authority (existing project: %s)",
  (existingProject) => {
    const value = {
      ...readOnlySession(),
      ...(existingProject
        ? { existing_project: true, analysis_complete: null }
        : {}),
    };
    const commitment = {
      ...expected,
      expectedReadOnly: true,
      expectedExistingProject: existingProject,
    };
    const parsed = parseGhidraSessionInfo(value, commitment);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value).toMatchObject({
      read_only: true,
      capabilities: value.capabilities,
      analysis_complete: existingProject ? null : true,
    });

    refuseHandshake({ ...value, read_only: false }, commitment);
    for (const edit of databaseEdits)
      refuseHandshake(
        {
          ...value,
          capabilities: value.capabilities.map((method) =>
            method === "ping" ? edit : method,
          ),
        },
        commitment,
      );
  },
);

it("binds existing-project identity and unknown analysis completeness independently", () => {
  const imported = readOnlySession();
  const windows = { ...expected, expectedReadOnly: true };
  const project = { ...windows, expectedExistingProject: true };
  const existing = {
    ...imported,
    existing_project: true,
    analysis_complete: null,
  };
  refuseHandshake({ ...imported, existing_project: true }, windows);
  refuseHandshake({ ...imported, analysis_complete: null }, project);
  refuseHandshake({ ...imported, analysis_complete: null }, windows);
  refuseHandshake({ ...existing, analysis_complete: true }, project);
  refuseHandshake({ ...existing, analysis_timed_out: true }, project);
});
