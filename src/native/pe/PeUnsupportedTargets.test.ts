import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dosMz } from "../../domain/binaryTarget.fixture.js";
import { inspectPeResourcesInputSchema } from "../../domain/native/peResources.js";
import { inspectPeCertificatesInputSchema } from "../../domain/native/peCertificates.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PeResourcesProvider } from "./PeResourcesProvider.js";
import { PeCertificatesProvider } from "./PeCertificatesProvider.js";

it.each(["resources", "certificates"] as const)(
  "classifies a valid DOS target as unsupported for PE %s",
  async (operation) => {
    const root = await createTestTempDirectory("rea-pe-dos-classification-");
    const path = join(root, "program.exe");
    const bytes = dosMz(1024);
    await writeFile(path, bytes);
    const provider =
      operation === "resources"
        ? new PeResourcesProvider()
        : new PeCertificatesProvider();
    const input =
      operation === "resources"
        ? inspectPeResourcesInputSchema.parse({ path })
        : inspectPeCertificatesInputSchema.parse({ path });
    try {
      const result = await provider.inspect(input);
      if (result.ok) throw new Error("Expected unsupported target");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "unsupported_target",
        category: "unsupported_target",
      });
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
      await writeFile(path, Buffer.from("MZ"));
      const malformed = await provider.inspect(input);
      if (malformed.ok) throw new Error("Expected malformed input");
      expect(projectAnalysisError(malformed.error)).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
      });
    } finally {
      await provider.close();
    }
  },
);
