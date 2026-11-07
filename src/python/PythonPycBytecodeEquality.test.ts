import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
  PYTHON_PYC_SHARED_TABLE_MAGICS,
  pythonPycBytecodeIdentity,
} from "./PythonPycBytecodeEquality.js";

const raw = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (bytes: Buffer, magic: number): string =>
  pythonPycBytecodeIdentity(bytes, magic, raw(bytes));

it("keeps raw bytecode identity under the magics whose builds carry two opcode tables", () => {
  // Opcode 88 carries four cache code units in the 3619 table and none in the
  // 3621 table, where it is LOAD_FAST_BORROW; only the cache bytes differ.
  const first = Buffer.from([88, 0, 1, 1, 2, 2, 3, 3, 4, 4, 83, 0]);
  const second = Buffer.from([88, 0, 9, 9, 9, 9, 9, 9, 9, 9, 83, 0]);
  expect(identity(first, 3619)).toBe(identity(second, 3619));
  expect(identity(first, 3621)).not.toBe(identity(second, 3621));
  expect([...PYTHON_PYC_SHARED_TABLE_MAGICS.keys()]).toEqual([3615, 3620]);
  for (const magic of PYTHON_PYC_SHARED_TABLE_MAGICS.keys()) {
    expect(identity(first, magic), String(magic)).toBe(
      `${String(first.length)}:${raw(first)}`,
    );
    expect(identity(first, magic)).not.toBe(identity(second, magic));
  }
  // Opcode 44 carries five cache units in the 3614 and 3616 tables around 3615.
  const third = Buffer.from([44, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 83, 0]);
  const fourth = Buffer.from([44, 0, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 83, 0]);
  for (const magic of [3614, 3616])
    expect(identity(third, magic), String(magic)).toBe(identity(fourth, magic));
  expect(identity(third, 3615)).not.toBe(identity(fourth, 3615));
});
