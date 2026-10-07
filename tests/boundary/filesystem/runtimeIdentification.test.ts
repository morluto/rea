import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { runProviderAnalysis } from "../../../src/composition/directAnalysis.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import {
  identifyRuntimes,
  runtimeIdentificationResultSchema,
} from "../../../src/domain/runtimeIdentification.js";

describe("runtime identification", () => {
  it("identifies APK runtime families and exposes missing semantic providers", async () => {
    const root = await createTestTempDirectory("rea-runtime-");
    const path = join(root, "Fixture.apk");
    await writeApkRuntimeFixture(path);

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const first = identifyRuntimes({ inventory_evidence: [inventory] });
    const second = identifyRuntimes({ inventory_evidence: [inventory] });
    expect(first).toEqual(second);
    expect(runtimeIdentificationResultSchema.parse(first)).toMatchObject({
      root_format: "apk",
      coverage: {
        status: "complete-within-inventory",
        inventory_complete: true,
      },
    });
    expect(first.runtimes.map(({ family }) => family)).toEqual([
      "android",
      "javascript",
      "jvm",
      "native",
      "webassembly",
    ]);
    expect(first.runtimes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          family: "android",
          inspection: "available",
          provider_id: "rea-android-application",
        }),
        expect.objectContaining({
          family: "jvm",
          inspection: "provider-missing",
          provider_id: null,
        }),
        expect.objectContaining({
          family: "webassembly",
          inspection: "provider-missing",
          provider_id: null,
        }),
        expect.objectContaining({
          family: "javascript",
          inspection: "available",
          provider_id: "rea-javascript-application",
        }),
        expect.objectContaining({
          family: "native",
          inspection: "provider-selection-required",
          provider_id: null,
        }),
      ]),
    );
    const widened = runtimeIdentificationResultSchema.parse({
      ...first,
      root_format: "x".repeat(101),
      source_evidence_ids: Array.from(
        { length: 101 },
        () => inventory.evidence_id,
      ),
      limitations: Array.from({ length: 101 }, () => "x".repeat(4_097)),
      runtimes: first.runtimes.map((runtime) => ({
        ...runtime,
        ...(runtime.provider_id === null
          ? { reason: "x".repeat(1_001) }
          : { provider_id: `provider-${"x".repeat(200)}` }),
        observations: runtime.observations.map((observation) => ({
          ...observation,
          path: "x".repeat(4_097),
          format: "x".repeat(101),
        })),
      })),
    });
    expect(widened.limitations).toHaveLength(101);
    expect(widened.runtimes[0]?.observations[0]?.path).toHaveLength(4_097);
    const available = first.runtimes.find(
      ({ inspection }) => inspection === "available",
    );
    if (available === undefined)
      throw new TypeError("Expected an available runtime provider");
    expect(
      runtimeIdentificationResultSchema.safeParse({
        ...first,
        runtimes: [{ ...available, provider_id: null, reason: "Missing." }],
      }).success,
    ).toBe(false);
  });

  it("accepts more than 100 supplied inventory Evidence records", async () => {
    const root = await createTestTempDirectory("rea-runtime-pages-");
    const path = join(root, "Fixture.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("one.js", new TextReader("one"));
    await writeFile(path, await writer.close());
    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const result = identifyRuntimes({
      inventory_evidence: Array.from({ length: 101 }, () => inventory),
    });

    expect(result.source_evidence_ids).toHaveLength(101);
    expect(result.coverage.status).toBe("complete-within-inventory");
    expect(result.runtimes).toContainEqual(
      expect.objectContaining({
        family: "javascript",
        observations: expect.arrayContaining([
          expect.objectContaining({ path: "one.js" }),
        ]),
      }),
    );
  });

  it("does not route nested DEX content to the APK-only provider", async () => {
    const root = await createTestTempDirectory("rea-runtime-dex-");
    const path = join(root, "Fixture.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "classes.dex",
      new Uint8ArrayReader(
        Uint8Array.from([...Buffer.from("dex\n035\0"), 0, 0, 0, 0]),
      ),
    );
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const result = identifyRuntimes({ inventory_evidence: [inventory] });

    expect(result.runtimes).toContainEqual(
      expect.objectContaining({
        family: "android",
        inspection: "provider-selection-required",
        provider_id: null,
      }),
    );
  });
});

const writeApkRuntimeFixture = async (path: string): Promise<void> => {
  const writer = new ZipWriter(new Uint8ArrayWriter());
  await writer.add(
    "AndroidManifest.xml",
    new Uint8ArrayReader(Uint8Array.from([3, 0, 8, 0, 8, 0, 0, 0])),
  );
  await writer.add(
    "classes.dex",
    new Uint8ArrayReader(
      Uint8Array.from([...Buffer.from("dex\n035\0"), 0, 0, 0, 0]),
    ),
  );
  await writer.add(
    "assets/Fixture.class",
    new Uint8ArrayReader(
      Uint8Array.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, 0, 61]),
    ),
  );
  await writer.add(
    "assets/module.wasm",
    new Uint8ArrayReader(Uint8Array.from([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])),
  );
  await writer.add("assets/main.js", new TextReader("bridge.call();"));
  await writer.add(
    "lib/arm64-v8a/libfixture.so",
    new Uint8ArrayReader(Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0])),
  );
  await writeFile(path, await writer.close());
};
