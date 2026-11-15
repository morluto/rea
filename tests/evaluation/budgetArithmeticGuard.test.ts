import { describe, expect, it } from "vitest";
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

describe("not-an-allowance markers", () => {
  const reader = (declaration: readonly string[]) =>
    [
      "class Reader {",
      ...declaration,
      "  read(size: number): void {",
      "    this.#seen += size;",
      "    if (this.#seen > LIMIT) this.#cut = true;",
      "    this.#remainingBytes -= size;",
      "  }",
      "}",
    ].join("\n");
  // The marker comments hold no field arithmetic, so the raw source serves as
  // the comment-stripped content too.
  const count = (source: string) => budgetArithmeticCount(source, { source });

  it("exempts a field whose declaration carries a reasoned marker", () => {
    expect(
      count(
        reader([
          "  // not-an-allowance: observed total, compared only to report a cut.",
          "  #seen = 0;",
        ]),
      ),
    ).toBe(1);
    expect(
      count(
        reader([
          "  #seen = 0; // not-an-allowance: observed total for the cut flag.",
        ]),
      ),
    ).toBe(1);
  });

  it("exempts a named allowance field only by its own marker", () => {
    expect(
      count(
        reader([
          "  #seen = 0;",
          "  // not-an-allowance: write cursor named for history.",
          "  #remainingBytes = 0;",
        ]),
      ),
    ).toBe(1);
  });

  it.each([
    [["  // not-an-allowance:", "  #seen = 0;"]],
    [["  // generation-cap: another guard's marker.", "  #seen = 0;"]],
    [
      [
        "  /* not-an-allowance: block comments are not markers. */",
        "  #seen = 0;",
      ],
    ],
    [
      [
        "  // not-an-allowance: separated by code.",
        "  #other = 0;",
        "  #seen = 0;",
      ],
    ],
  ])("does not exempt %j", (declaration) => {
    expect(count(reader(declaration))).toBe(2);
  });
});

it("binds a marker to its own class field", () => {
  const source = [
    "class Tally {",
    "  // not-an-allowance: observed total for the truncation flag.",
    "  #bytes = 0;",
    "  read(size: number): void {",
    "    this.#bytes += size;",
    "    if (this.#bytes > LIMIT) this.#cut = true;",
    "  }",
    "}",
    "class Allowance {",
    "  #bytes = 0;",
    "  read(size: number): void {",
    "    this.#bytes += size;",
    "    if (this.#bytes > LIMIT) throw failure();",
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(source, { source })).toBe(1);
});

it("does not exempt a class field through a marked object property", () => {
  const source = [
    "class Reader {",
    "  bytes = 0;",
    "  options(): object {",
    "    return {",
    "      // not-an-allowance: an option, not the field.",
    "      bytes: 0,",
    "    };",
    "  }",
    "  read(size: number): void {",
    "    this.bytes += size;",
    "    if (this.bytes > LIMIT) throw failure();",
    "  }",
    "}",
  ].join("\n");
  expect(budgetArithmeticCount(source, { source })).toBe(1);
});
