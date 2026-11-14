import { expect, it } from "vitest";
import {
  inspectPythonPycInputSchema,
  pythonPycMarshalProfile,
  PYTHON_PYC_MARSHAL_PROFILES,
  pythonPycHeaderSchema,
} from "./pythonPyc.js";
import { pythonBytecodeIdentity } from "./pythonBytecodeIdentity.js";

const hashHeader = {
  magic: 3531,
  python_version: "3.12",
  code_layout: "py311",
  flags: 3,
  hash_based: true,
  check_source: true,
  source_hash_hex: "0123456789abcdef",
  source_mtime: null,
  source_size: null,
};

it.each(["", "ab", "g".repeat(16)])(
  "rejects an invalid source hash %j",
  (source_hash_hex) => {
    expect(
      pythonPycHeaderSchema.safeParse({ ...hashHeader, source_hash_hex })
        .success,
    ).toBe(false);
  },
);

it.each([
  { hash_based: false },
  { check_source: false },
  { source_hash_hex: null },
  { source_mtime: 0 },
  { source_size: 0 },
])("keeps header facts consistent with the recorded flags: %j", (changed) => {
  expect(
    pythonPycHeaderSchema.safeParse({ ...hashHeader, ...changed }).success,
  ).toBe(false);
});

it("preserves unknown raw header flags and valid hash bytes", () => {
  const header = { ...hashHeader, flags: 0x80000003 };
  expect(pythonPycHeaderSchema.parse(header)).toEqual(header);
});

it("keeps pinned CPython identity separate from standalone marshal coverage", () => {
  expect(pythonPycMarshalProfile(3394)).toEqual({
    code_layout: "py37",
    negative_code_fields: "accepted",
  });
  expect(pythonBytecodeIdentity(3390)).toEqual({
    pythonVersion: "3.7",
    headerBytes: 12,
  });
  expect(pythonBytecodeIdentity(3391)).toEqual({
    pythonVersion: "3.7",
    headerBytes: 12,
  });
  expect(pythonPycMarshalProfile(3413)).toEqual({
    code_layout: "py38",
    negative_code_fields: "rejected",
  });
  expect(pythonPycMarshalProfile(3401)?.negative_code_fields).toBe("accepted");
  expect(pythonPycMarshalProfile(3410)?.negative_code_fields).toBe(
    "revision-dependent",
  );
  expect(pythonPycMarshalProfile(3411)?.negative_code_fields).toBe("rejected");
  expect(pythonPycMarshalProfile(3531)).toEqual({
    code_layout: "py311",
    negative_code_fields: "rejected",
  });
  expect(pythonPycMarshalProfile(3571)).toEqual({
    code_layout: "py311",
    negative_code_fields: "rejected",
  });
  expect(pythonBytecodeIdentity(3627)).toEqual({
    pythonVersion: "3.14",
    headerBytes: 16,
  });
  expect(pythonPycMarshalProfile(3627)).toEqual({
    code_layout: "py311",
    negative_code_fields: "rejected",
  });
  expect(pythonBytecodeIdentity(3666)).toEqual({
    pythonVersion: "3.15",
    headerBytes: 16,
  });
  expect(pythonBytecodeIdentity(3663)).toEqual({
    pythonVersion: "3.15",
    headerBytes: 16,
  });
  expect(pythonPycMarshalProfile(3663)?.code_layout).toBe("py311");
  expect(pythonPycMarshalProfile(3666)?.code_layout).toBe("py311");
  // Only magics checked against real CPython are pinned: the neighbouring
  // 3.14 and 3.15 pre-release magics and the 3.16 magics stay unknown.
  for (const magic of [3600, 3626, 3650, 3662, 3664, 3665, 3706]) {
    expect(pythonBytecodeIdentity(magic), String(magic)).toBeNull();
    expect(pythonPycMarshalProfile(magic), String(magic)).toBeNull();
  }
  expect(pythonPycMarshalProfile(3450)).toBeNull();
  expect(pythonPycMarshalProfile(62171)).toBeNull();
  expect(PYTHON_PYC_MARSHAL_PROFILES.size).toBeGreaterThan(80);
});

it("rejects extra inspect arguments", () => {
  expect(
    inspectPythonPycInputSchema.safeParse({
      path: "/artifacts/module.pyc",
      detail: "complete",
    }).success,
  ).toBe(false);
});
