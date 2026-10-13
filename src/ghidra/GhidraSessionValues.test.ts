import { describe, expect, it } from "vitest";

import {
  GHIDRA_SESSION_CAPABILITIES,
  GHIDRA_MUTATING_OPERATIONS,
  parseGhidraSessionInfo,
} from "./GhidraSessionValues.js";

const expected = {
  runId: "d6fcbb66-e829-4ff6-a535-0035aec63139",
  providerVersion: "12.1.4",
  profileDigest: "a".repeat(64),
  targetSha256: "b".repeat(64),
  expectedLanguageId: "x86:LE:16:Real Mode",
  expectedCompilerSpecId: "default",
};
const session = (
  language = expected.expectedLanguageId,
  compiler = "default",
) => ({
  name: "REA Ghidra bridge",
  run_id: expected.runId,
  profile_digest: expected.profileDigest,
  provider: { id: "ghidra", version: expected.providerVersion },
  read_only: false,
  analysis_complete: true,
  analysis_timed_out: false,
  capabilities: [...GHIDRA_SESSION_CAPABILITIES],
  target: {
    name: "legacy.exe",
    language_id: language,
    compiler_spec_id: compiler,
    image_base: "0x0",
    default_address_space: "ram",
    sha256: expected.targetSha256,
  },
});

describe("Ghidra DOS import commitment", () => {
  it("accepts the exact admitted real-mode language and compiler", () => {
    expect(parseGhidraSessionInfo(session(), expected).ok).toBe(true);
  });
  it("rejects a 32-bit interpretation even when artifact and profile hashes match", () => {
    expect(
      parseGhidraSessionInfo(session("x86:LE:32:default"), expected).ok,
    ).toBe(false);
  });
  it("rejects compiler drift independently of the language", () => {
    expect(
      parseGhidraSessionInfo(session(undefined, "windows"), expected).ok,
    ).toBe(false);
  });
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
  it("retains the referenced identity and observed load state", () => {
    const parsed = parseGhidraSessionInfo({ ...session(), pdb }, expected);
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.pdb).toEqual(pdb);
  });
  it("preserves missing attributes as unknown", () => {
    const unknown = Object.fromEntries(
      Object.keys(pdb).map((key) => [key, null]),
    );
    const parsed = parseGhidraSessionInfo(
      { ...session(), pdb: unknown },
      expected,
    );
    if (!parsed.ok) throw parsed.error;
    expect(parsed.value.pdb).toEqual(unknown);
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
      { policy: "o32-integer-registers-v1", remapped: 2, retyped: 1 },
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

describe("Ghidra mutation handshake", () => {
  it("requires the exact mutation authority and rejects duplicate capabilities", () => {
    const value = session();
    expect(
      parseGhidraSessionInfo({ ...value, read_only: true }, expected).ok,
    ).toBe(false);
    expect(
      parseGhidraSessionInfo(
        { ...value, capabilities: [...value.capabilities, "ping"] },
        expected,
      ).ok,
    ).toBe(false);
    expect(
      parseGhidraSessionInfo(
        {
          ...value,
          capabilities: value.capabilities.filter(
            (c) => c !== "annotate_native_function",
          ),
        },
        expected,
      ).ok,
    ).toBe(false);
  });
  it("excludes database mutation from the Windows transport handshake", () => {
    const value = session();
    const windows = {
      ...value,
      read_only: true,
      capabilities: value.capabilities.filter(
        (c) => !GHIDRA_MUTATING_OPERATIONS.has(c),
      ),
    };
    expect(
      parseGhidraSessionInfo(windows, { ...expected, expectedReadOnly: true })
        .ok,
    ).toBe(true);
    expect(
      parseGhidraSessionInfo(value, { ...expected, expectedReadOnly: true }).ok,
    ).toBe(false);
  });
  it("treats address naming as database mutation", () => {
    expect([...GHIDRA_MUTATING_OPERATIONS].sort()).toEqual([
      "annotate_native_function",
      "set_address_name",
      "set_addresses_names",
    ]);
    const value = session();
    for (const naming of ["set_address_name", "set_addresses_names"]) {
      expect(value.capabilities).toContain(naming);
      expect(
        parseGhidraSessionInfo(
          {
            ...value,
            capabilities: value.capabilities.filter((c) => c !== naming),
          },
          expected,
        ).ok,
      ).toBe(false);
    }
  });
});
