import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { inspectElfDependenciesInputSchema } from "../../domain/native/elfDependencies.js";
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
