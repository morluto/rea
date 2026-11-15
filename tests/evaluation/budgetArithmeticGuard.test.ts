import { expect, it } from "vitest";
import { budgetArithmeticCount } from "../../scripts/verify/budget-arithmetic-guard.mjs";

it("counts arithmetic on fields named for an allowance", () => {
  expect(budgetArithmeticCount("this.#remainingBytes -= size;")).toBe(1);
  expect(budgetArithmeticCount("this.retained += size;")).toBe(1);
  expect(budgetArithmeticCount("this.#arenaWriteOffset += size;")).toBe(0);
});

it("counts hand-checked fields inside a hand-written Budget class", () => {
  const cuda = [
    "export class CudaMetadataBudget {",
    "  #visits = 0;",
    "  #readBytes = 0;",
    "  visit(): void {",
    "    if (++this.#visits > 262144) throw failure();",
    "  }",
    "  read(size: number): void {",
    "    if (size > LIMIT - this.#readBytes) throw failure();",
    "    this.#readBytes += size;",
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(cuda)).toBe(2);
});

it("ignores unchecked tallies and fields not compared with a limit", () => {
  const tallies = [
    "class ProtobufBudget {",
    "  async checkpoint(): Promise<void> {",
    "    if (++this.#work % 256 === 0) await yieldTurn();",
    "    this.#transient += bytes;",
    "    const done = () => this.#transient;",
    "  }",
    "}",
    "class Reader {",
    "  read(size: number): void {",
    "    this.#observed += size;",
    "    if (this.#observed > this.#previous) this.#grew = true;",
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(tallies)).toBe(0);
});

it("counts a field outside Budget classes compared with a limit once", () => {
  const reader = [
    "class Reader {",
    "  read(size: number): void {",
    "    if (this.#bytes + size > LIMIT) throw failure();",
    "    this.#bytes += size;",
    "  }",
    "  key(size: number): void {",
    "    this.#keyBytes += size;",
    "    if (this.#keyBytes > this.input.max_file_bytes) throw failure();",
    "    this.#keyBytes += 1;",
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(reader)).toBe(2);
});

it("counts the same field name separately in each class", () => {
  const readers = [
    "class First {",
    "  read(size: number): void {",
    "    if (this.#bytes + size > LIMIT) throw failure();",
    "    this.#bytes += size;",
    "  }",
    "}",
    "class SecondBudget {",
    "  #bytes = 0;",
    "  observe(size: number): void {",
    "    this.#bytes += size;",
    "  }",
    "}",
    "class Third {",
    "  read(size: number): void {",
    "    this.#bytes += size;",
    "    if (this.#bytes > LIMIT) throw failure();",
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(readers)).toBe(2);
});

it.each([
  "CAPACITY",
  "FACT_ALLOWANCE",
  "FACT_BUDGET",
  "MAX_BYTES",
  "byteLimit",
])("counts a field compared with %s", (limit) => {
  const reader = [
    "class Reader {",
    "  read(size: number): void {",
    "    this.#facts += size;",
    `    if (this.#facts > ${limit}) throw failure();`,
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(reader)).toBe(1);
});
