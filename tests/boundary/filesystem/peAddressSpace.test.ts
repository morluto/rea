import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createBinaryHardeningService } from "../../../src/composition/binaryDiagnostics/binaryHardening.js";
import { createNativeExportsService } from "../../../src/composition/binaryDiagnostics/nativeExports.js";
import { createPeCertificatesService } from "../../../src/composition/binaryDiagnostics/peCertificates.js";
import { createPeImportsService } from "../../../src/composition/binaryDiagnostics/peImports.js";
import { createPeLoadConfigService } from "../../../src/composition/binaryDiagnostics/peLoadConfig.js";
import { createPeResourcesService } from "../../../src/composition/binaryDiagnostics/peResources.js";
import { binaryHardeningSchema } from "../../../src/domain/native/binaryHardening.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import { peCertificatesSchema } from "../../../src/domain/native/peCertificates.js";
import { peImportsSchema } from "../../../src/domain/native/peImports.js";
import { peLoadConfigSchema } from "../../../src/domain/native/peLoadConfig.js";
import { peResourcesSchema } from "../../../src/domain/native/peResources.js";
import { peLoadConfigImage } from "../../../src/native/pe/PeLoadConfig.fixture.js";
import { peImportImage } from "../../fixtures/binaryDiagnostics/peImports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

const write = async (name: string, bytes: Buffer): Promise<string> => {
  const root = await createTestTempDirectory("rea-pe-address-space-");
  const path = join(root, name);
  await writeFile(path, bytes);
  return path;
};

const normalized = async <T>(
  result: Promise<
    | { readonly ok: true; readonly value: { normalized_result: unknown } }
    | { readonly ok: false; readonly error: unknown }
  >,
  parse: (value: unknown) => T,
): Promise<T> => {
  const settled = await result;
  if (!settled.ok) throw settled.error;
  return parse(settled.value.normalized_result);
};

it("reports one image base across every static PE reader of the same image", async () => {
  // PeLoadConfig.fixture's PE32+ image is loaded at 0x180000000.
  const path = await write("app.dll", peLoadConfigImage());
  const imageBase = "0x180000000";
  const reports = [
    await normalized(createPeImportsService().inspect({ path }), (value) =>
      peImportsSchema.parse(value),
    ),
    await normalized(createNativeExportsService().inspect({ path }), (value) =>
      nativeExportsSchema.parse(value),
    ),
    await normalized(createPeLoadConfigService().inspect({ path }), (value) =>
      peLoadConfigSchema.parse(value),
    ),
    await normalized(createPeResourcesService().inspect({ path }), (value) =>
      peResourcesSchema.parse(value),
    ),
    await normalized(createPeCertificatesService().inspect({ path }), (value) =>
      peCertificatesSchema.parse(value),
    ),
  ];
  for (const report of reports)
    expect(report).toMatchObject({ image_base: imageBase });
  const hardening = await normalized(
    createBinaryHardeningService().inspect({ path }),
    (value) => binaryHardeningSchema.parse(value),
  );
  expect(hardening.images).toMatchObject([{ image_base: imageBase }]);
  // A load-config VA is the same base plus its RVA.
  const loadConfig = peLoadConfigSchema.parse(reports[2]);
  const callback = loadConfig.tls?.callbacks[0];
  if (callback?.rva === null || callback === undefined)
    throw new Error("Expected a TLS callback RVA");
  expect(callback.va).toBe(
    `0x${(BigInt(imageBase) + BigInt(callback.rva)).toString(16)}`,
  );
});

it.each([32, 64] as const)(
  "gives each PE%d import address table slot as a VA providers accept",
  async (bits) => {
    const path = await write("imports.exe", peImportImage({ bits }));
    const report = await normalized(
      createPeImportsService().inspect({ path }),
      (value) => peImportsSchema.parse(value),
    );
    const base = report.image_base;
    if (base === undefined) throw new Error("Expected an image base");
    const functions = report.imports.flatMap((dll) => dll.functions);
    expect(functions.length).toBeGreaterThan(0);
    for (const row of functions)
      expect(row.iat_va).toBe(
        `0x${(BigInt(base) + BigInt(row.iat_rva)).toString(16)}`,
      );
  },
);
