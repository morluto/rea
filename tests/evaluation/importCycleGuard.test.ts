import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { expectImportCycles } from "../fixtures/importCycles.js";
import { createTestTempDirectory } from "../fixtures/temporaryDirectory.js";

it.each(["./self.js", "./%73elf.js?view=1#fragment"])(
  "detects self-import %s and tracks its allowed edge",
  async (specifier) => {
    const root = await createTestTempDirectory("rea-import-cycle-");
    await writeFile(
      join(root, "self.ts"),
      `import ${JSON.stringify(specifier)};\n`,
    );
    expect(() => expectImportCycles(root, [], [])).toThrow();
    expectImportCycles(root, [["self.ts"]], ["self.ts -> self.ts"]);
    expect(() => expectImportCycles(root, [["self.ts"]], [])).toThrow();
  },
);

it("does not include cycles in test-only fixtures", async () => {
  const root = await createTestTempDirectory("rea-import-cycle-");
  await writeFile(
    join(root, "sample.fixture.ts"),
    'import "./sample.fixture.js";\n',
  );
  await writeFile(join(root, "sample.test.ts"), 'import "./sample.test.js";\n');
  await writeFile(join(root, "sample.spec.ts"), 'import "./sample.spec.js";\n');
  await writeFile(join(root, "production.ts"), "export const value = 1;\n");
  expectImportCycles(root, [], []);
});
