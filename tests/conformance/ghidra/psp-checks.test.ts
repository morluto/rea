import assert from "node:assert/strict";
import { it } from "vitest";
import { parsePspReadelfAbi } from "./psp-fixture.mjs";

// GNU readelf 2.44 output from the maintained PSPDEV v20261001 fixture.
const observed = `MIPS ABI Flags Version: 0
ISA: MIPS2
GPR size: 32
CPR1 size: 32
CPR2 size: 0
FP ABI: Hard float (single precision)
ISA Extension: None
ASEs:
  None
FLAGS 1: 00000001
FLAGS 2: 00000000
`;

it("reads the independent PSP producer's single-float declaration", () => {
  assert.deepEqual(parsePspReadelfAbi(observed), {
    version: 0,
    isaLevel: 2,
    isaRevision: 0,
    gprSize: 1,
    cpr1Size: 1,
    cpr2Size: 0,
    fpAbi: 2,
    isaExtension: 0,
    ases: 0,
    flags1: 1,
    flags2: 0,
  });
});

it.each([
  ["ISA: MIPS2", "ISA: MIPS32r2"],
  ["GPR size: 32", "GPR size: 64"],
  ["Hard float (single precision)", "Hard float (double precision)"],
  ["FLAGS 1: 00000001", "FLAGS 1: 00000003"],
  ["FLAGS 2: 00000000", "FLAGS 2: 00000001"],
  ["MIPS ABI Flags Version: 0", "MIPS ABI Flags Version: 1"],
  ["CPR1 size: 32", "CPR1 size: 0"],
  ["ISA Extension: None", "ISA Extension: R5900"],
  ["GPR size: 32", "GPR size: 32\nGPR size: 32"],
  ["FLAGS 1: 00000001", ""],
])(
  "rejects unsupported or ambiguous independent ABI output: %s",
  (before, after) => {
    assert.throws(() => parsePspReadelfAbi(observed.replace(before, after)));
  },
);
