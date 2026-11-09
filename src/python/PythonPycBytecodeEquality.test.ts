import { createHash } from "node:crypto";
import { expect, it } from "vitest";

import { pythonPycBytecodeIdentity } from "./PythonPycBytecodeEquality.js";

const raw = (bytes: Buffer): string =>
  createHash("sha256").update(bytes).digest("hex");
const identity = (bytes: Buffer, magic: number): string =>
  pythonPycBytecodeIdentity(bytes, magic, raw(bytes));

it("skips inline-cache units only under the pinned 3.14 and 3.15 magics", () => {
  // Opcode 80 carries nine cache code units in the 3627 table; only the cache
  // bytes differ between the two bytecodes.
  const first = Buffer.from([80, 0, ...Array(18).fill(1), 83, 0]);
  const second = Buffer.from([80, 0, ...Array(18).fill(9), 83, 0]);
  expect(identity(first, 3627)).toBe(identity(second, 3627));
  // A magic with no pinned table keeps the raw bytecode digest, so code
  // objects that differ only in cache units stay distinct.
  expect(identity(first, 3619)).toBe(`${String(first.length)}:${raw(first)}`);
  expect(identity(first, 3619)).not.toBe(identity(second, 3619));
});
