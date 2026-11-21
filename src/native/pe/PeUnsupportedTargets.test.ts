import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { dosMz, nonPeWindowsMz } from "../../domain/binaryTarget.fixture.js";
import { inspectPeResourcesInputSchema } from "../../domain/native/peResources.js";
import { inspectPeCertificatesInputSchema } from "../../domain/native/peCertificates.js";
import { inspectPeRichHeaderInputSchema } from "../../domain/native/peRichHeader.js";
import { projectAnalysisError } from "../../domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../../tests/fixtures/temporaryDirectory.js";
import { PeResourcesProvider } from "./PeResourcesProvider.js";
import { PeCertificatesProvider } from "./PeCertificatesProvider.js";
import { PeRichHeaderProvider } from "./PeRichHeaderProvider.js";

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

it("classifies a valid DOS target as unsupported for the PE Rich header", async () => {
  const root = await createTestTempDirectory("rea-pe-dos-classification-");
  const path = join(root, "program.exe");
  const bytes = dosMz(1024);
  await writeFile(path, bytes);
  const provider = new PeRichHeaderProvider();
  const input = inspectPeRichHeaderInputSchema.parse({ path });
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
});
