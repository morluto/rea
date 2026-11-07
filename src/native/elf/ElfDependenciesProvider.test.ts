import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { inspectElfDependenciesInputSchema } from "../../domain/native/elfDependencies.js";
import { elfDependencyFixture } from "./ElfDependencies.fixture.js";
import { ElfDependenciesProvider } from "./ElfDependenciesProvider.js";
import { ElfDependencyCountFailure } from "./ElfDependencyParser.js";

it("keeps the read file's identity when parsing fails", async () => {
  const root = await createTestTempDirectory("rea-elf-dependencies-parse-");
  const path = join(root, "not-elf");
  const bytes = Buffer.from("not an ELF image, but it was read completely");
  await writeFile(path, bytes);
  const provider = new ElfDependenciesProvider();
  try {
    const result = await provider.inspect(
      inspectElfDependenciesInputSchema.parse({ path }),
    );
    if (result.ok) throw new Error("Expected a parse failure");
    expect(result.error.partialObservation).toEqual({
      kind: "file-snapshot-hash",
      path,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
    });
  } finally {
    await provider.close();
  }
});

const inspectWith = async (
  bytes: Buffer,
  budgets: Record<string, number> = {},
) => {
  const root = await createTestTempDirectory("rea-elf-dependencies-limit-");
  const path = join(root, "program");
  await writeFile(path, bytes);
  const provider = new ElfDependenciesProvider();
  try {
    return await provider.inspect(
      inspectElfDependenciesInputSchema.parse({ path, ...budgets }),
    );
  } finally {
    await provider.close();
  }
};

const countLimitOf = async (
  bytes: Buffer,
  budgets: Record<string, number> = {},
) => {
  const result = await inspectWith(bytes, budgets);
  if (result.ok) throw new Error("Expected a limit failure");
  expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
  const error = result.error as AnalysisResourceConstraintError;
  expect(error.retryable).toBe(false);
  expect(error.cause).toBeInstanceOf(ElfDependencyCountFailure);
  return (error.cause as ElfDependencyCountFailure).limit;
};

it.each([
  ["max_needed", 65536],
  ["max_versions", 65536],
  ["max_imports", 262144],
] as const)(
  "reports which budget failed and recovers when %s is raised",
  async (parameter, ceiling) => {
    const image = elfDependencyFixture();
    expect(await countLimitOf(image, { [parameter]: 2 })).toMatchObject({
      kind: "budget",
      parameter,
      value: 2,
      ceiling,
    });
    const raised = await inspectWith(image, { [parameter]: ceiling });
    if (!raised.ok) throw raised.error;
    expect(raised.value.coverage.status).toBe("complete");
  },
);

it("reports a fixed dynamic-symbol ceiling that a raised budget cannot clear", async () => {
  const imports = Array.from({ length: 262145 }, (_, index) => ({
    name: `s${String(index)}`,
  }));
  const image = elfDependencyFixture({ imports });
  const ceiling = { kind: "ceiling", value: 262144 };
  expect(await countLimitOf(image)).toMatchObject(ceiling);
  expect(await countLimitOf(image, { max_imports: 262144 })).toMatchObject(
    ceiling,
  );
});
