import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { inspectElfDependenciesInputSchema } from "../../domain/native/elfDependencies.js";
import { elfDependencyFixture } from "./ElfDependencies.fixture.js";
import { ElfDependenciesProvider } from "./ElfDependenciesProvider.js";

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

const remediationFor = async (
  bytes: Buffer,
  budgets: Record<string, number> = {},
): Promise<string | undefined> => {
  const root = await createTestTempDirectory("rea-elf-dependencies-limit-");
  const path = join(root, "program");
  await writeFile(path, bytes);
  const provider = new ElfDependenciesProvider();
  try {
    const result = await provider.inspect(
      inspectElfDependenciesInputSchema.parse({ path, ...budgets }),
    );
    if (result.ok) throw new Error("Expected a limit failure");
    expect(result.error).toBeInstanceOf(AnalysisResourceConstraintError);
    return (result.error as AnalysisResourceConstraintError).remediationAction;
  } finally {
    await provider.close();
  }
};

it.each([
  [{ max_needed: 2 }, "Raise max_needed above 2, up to 65536", "max_imports"],
  [
    { max_versions: 2 },
    "Raise max_versions above 2, up to 65536",
    "max_needed",
  ],
  [{ max_imports: 2 }, "Raise max_imports above 2, up to 262144", "max_needed"],
])(
  "names only the budget that failed for %j",
  async (budgets, advice, otherBudget) => {
    const remediation = await remediationFor(elfDependencyFixture(), budgets);
    expect(remediation).toContain(advice);
    expect(remediation).not.toContain(otherBudget);
  },
);

it("says a fixed dynamic-symbol ceiling has no runtime override", async () => {
  const imports = Array.from({ length: 262145 }, (_, index) => ({
    name: `s${String(index)}`,
  }));
  const remediation = await remediationFor(elfDependencyFixture({ imports }));
  expect(remediation).toContain("fixed ceiling of 262144 entries");
  expect(remediation).toContain("This release has no runtime override");
  expect(remediation).not.toMatch(/^Raise/u);
});
