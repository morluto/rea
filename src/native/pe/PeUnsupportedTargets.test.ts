import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dosMz, nonPeWindowsMz } from "../../domain/binaryTarget.fixture.js";
import { inspectPeResourcesInputSchema } from "../../domain/native/peResources.js";
import { inspectPeCertificatesInputSchema } from "../../domain/native/peCertificates.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PeResourcesProvider } from "./PeResourcesProvider.js";
import { PeCertificatesProvider } from "./PeCertificatesProvider.js";

it.each(
  (["DOS", "NE", "LE", "LX"] as const).flatMap((format) =>
    (["resources", "certificates"] as const).map((operation) => ({
      format,
      operation,
    })),
  ),
)(
  "classifies $format as unsupported for PE $operation",
  async ({ format, operation }) => {
    const root = await createTestTempDirectory("rea-pe-dos-classification-");
    const path = join(root, "program.exe");
    const bytes = format === "DOS" ? dosMz(1024) : nonPeWindowsMz(format);
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
        retryable: false,
        details: { operation: `inspect_pe_${operation}`, path },
      });
      expect(Buffer.compare(await readFile(path), bytes)).toBe(0);
    } finally {
      await provider.close();
    }
  },
);
