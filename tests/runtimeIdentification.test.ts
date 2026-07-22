import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { createTestTempDirectory } from "./fixtures/temporaryDirectory.js";

import { runProviderAnalysis } from "../src/application/DirectAnalysis.js";
import { parseEvidence } from "../src/domain/evidence.js";
import {
  identifyRuntimes,
  runtimeIdentificationResultSchema,
} from "../src/domain/runtimeIdentification.js";

describe("runtime identification", () => {
  it("identifies APK runtime families and exposes missing semantic providers", async () => {
    const root = await createTestTempDirectory("rea-runtime-");
    const path = join(root, "Fixture.apk");
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
      new Uint8ArrayReader(
        Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]),
      ),
    );
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {
        node_limit: 100,
        occurrence_limit: 100,
        edge_limit: 100,
      }),
    );
    const first = identifyRuntimes({ inventory_evidence: [inventory] });
    const second = identifyRuntimes({ inventory_evidence: [inventory] });
    expect(first).toEqual(second);
    expect(runtimeIdentificationResultSchema.parse(first)).toMatchObject({
      root_format: "apk",
      coverage: {
        status: "complete-within-inventory",
        inventory_complete: true,
        omitted_observations: 0,
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
  });

  it("reports bounded runtime-observation truncation", async () => {
    const root = await createTestTempDirectory("rea-runtime-limit-");
    const path = join(root, "Fixture.apk");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("one.js", new TextReader("one"));
    await writer.add("two.js", new TextReader("two"));
    await writeFile(path, await writer.close());
    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const result = identifyRuntimes({
      inventory_evidence: [inventory],
      limits: { max_observations: 1 },
    });
    expect(result.coverage).toMatchObject({
      status: "truncated",
      omitted_observations: expect.any(Number),
    });
    expect(result.coverage.omitted_observations).toBeGreaterThan(0);
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
