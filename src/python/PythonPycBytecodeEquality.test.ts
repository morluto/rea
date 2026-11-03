import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import {
  PYTHON_PYC_SHARED_TABLE_MAGIC,
  pythonPycBytecodeIdentity,
} from "./PythonPycBytecodeEquality.js";

const raw = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (bytes: Buffer, magic: number): string =>
  pythonPycBytecodeIdentity(bytes, magic, raw(bytes));

it("keeps raw bytecode identity under magic 3620, whose builds carry two opcode tables", () => {
  // Opcode 88 carries four cache code units in the 3619 table and none in the
  // 3621 table, where it is LOAD_FAST_BORROW; only the cache bytes differ.
  const first = Buffer.from([88, 0, 1, 1, 2, 2, 3, 3, 4, 4, 83, 0]);
  const second = Buffer.from([88, 0, 9, 9, 9, 9, 9, 9, 9, 9, 83, 0]);
  expect(identity(first, 3619)).toBe(identity(second, 3619));
  expect(identity(first, 3621)).not.toBe(identity(second, 3621));
  expect(PYTHON_PYC_SHARED_TABLE_MAGIC).toBe(3620);
  expect(identity(first, 3620)).toBe(`${String(first.length)}:${raw(first)}`);
  expect(identity(first, 3620)).not.toBe(identity(second, 3620));
});
