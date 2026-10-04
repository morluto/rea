import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { fragmentInventoryEvidence } from "../../fixtures/artifactEvidence.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

import { projectAppleApplicationEvidence } from "../../../src/application/AppleApplicationService.js";
import { runProviderAnalysis } from "../../../src/application/DirectAnalysis.js";
import { appleApplicationProjectionResultSchema } from "../../../src/domain/appleApplication.js";
import { parseEvidence } from "../../../src/domain/evidence.js";

// Real ZIP entries cross the former component and bridge-candidate limits.
const FRAMEWORK_COUNT = 250;
const SCRIPT_COUNT = 40;
const NATIVE_COUNT = 40;

async function createCompleteAppleProjection() {
  const root = await createTestTempDirectory("rea-apple-complete-");
  const path = join(root, "Complete.ipa");
  const writer = new ZipWriter(new Uint8ArrayWriter());
  for (let index = 0; index < FRAMEWORK_COUNT; index++) {
    const name = String(index).padStart(4, "0");
    await writer.add(
      `Payload/Complete.app/Frameworks/F${name}.framework/Info.plist`,
      new TextReader("<plist><dict/></plist>"),
    );
  }
  for (let index = 0; index < SCRIPT_COUNT; index++) {
    await writer.add(
      `Payload/Complete.app/script-${String(index).padStart(3, "0")}.js`,
      new TextReader("bridge.call();"),
    );
  }
  for (let index = 0; index < NATIVE_COUNT; index++) {
    await writer.add(
      `Payload/Complete.app/Frameworks/Native${String(index).padStart(3, "0")}.dylib`,
      new Uint8ArrayReader(
        Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
      ),
    );
  }
  await writeFile(path, await writer.close());

  const inventory = parseEvidence(
    await runProviderAnalysis(path, "inventory_artifact", {}),
  );
  const fragments = fragmentInventoryEvidence(inventory, 3);
  const result = projectAppleApplicationEvidence({
    inventory_evidence: fragments,
  });

  expect(result.ok).toBe(true);
  if (!result.ok) throw new TypeError("Could not project fixture inventory");
  const projection = appleApplicationProjectionResultSchema.parse(
    result.value.normalized_result,
  );
  expect([...projection.source_evidence_ids].sort()).toEqual(
    fragments.map(({ evidence_id }) => evidence_id).sort(),
  );
  return projection;
}

describe("Apple application projection", () => {
  it("projects deterministic IPA components and bridge hypotheses from exact inventory Evidence", async () => {
    const root = await createTestTempDirectory("rea-apple-");
    const path = join(root, "Fixture.ipa");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("Payload/Fixture.app/", undefined, { directory: true });
    await writer.add(
      "Payload/Fixture.app/Info.plist",
      new TextReader("<plist><dict/></plist>"),
    );
    await writer.add(
      "Payload/Fixture.app/Fixture",
      new Uint8ArrayReader(
        Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
      ),
    );
    await writer.add(
      "Payload/Fixture.app/Frameworks/React.framework/React",
      new Uint8ArrayReader(
        Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
      ),
    );
    await writer.add(
      "Payload/Fixture.app/main.js",
      new TextReader("bridge.call();"),
    );
    await writer.add(
      "Payload/Fixture.app/embedded.mobileprovision",
      new TextReader("opaque signing bytes"),
    );
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const first = projectAppleApplicationEvidence({
      inventory_evidence: [inventory],
    });
    const second = projectAppleApplicationEvidence({
      inventory_evidence: [inventory],
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    const left = appleApplicationProjectionResultSchema.parse(
      first.value.normalized_result,
    );
    const right = appleApplicationProjectionResultSchema.parse(
      second.value.normalized_result,
    );
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      root_format: "ipa",
      application_roots: ["Payload/Fixture.app"],
      coverage: {
        status: "complete-within-inventory",
        inventory_complete: true,
      },
    });
    expect(left.components.bundle_metadata).toHaveLength(1);
    expect(left.components.executables.length).toBeGreaterThanOrEqual(2);
    expect(left.components.frameworks).toHaveLength(1);
    expect(left.components.javascript).toHaveLength(1);
    expect(left.components.signing).toHaveLength(1);
    expect(left.runtime_families).toEqual(
      expect.arrayContaining(["javascript", "native", "react-native"]),
    );
    expect(left.bridge_candidates).toEqual([
      expect.objectContaining({
        basis: "javascript-and-native-content",
        native_path: "Payload/Fixture.app/Fixture",
      }),
      expect.objectContaining({
        basis: "react-native-convention",
        native_path: "Payload/Fixture.app/Frameworks/React.framework/React",
      }),
    ]);
    expect(JSON.stringify(left)).not.toContain("opaque signing bytes");
  });

  it("rejects non-IPA Evidence", async () => {
    const root = await createTestTempDirectory("rea-apple-invalid-");
    const path = join(root, "fixture.zip");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add("one.js", new TextReader("one"));
    await writeFile(path, await writer.close());
    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    expect(
      projectAppleApplicationEvidence({ inventory_evidence: [inventory] }),
    ).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisInputError" },
    });
  });
});

describe("Apple application projection completeness", () => {
  it("returns every component and bridge hypothesis from fragments of a real ZIP inventory", async () => {
    const projection = await createCompleteAppleProjection();
    expect(projection.components.frameworks).toHaveLength(FRAMEWORK_COUNT);
    expect(projection.components.bundle_metadata).toHaveLength(FRAMEWORK_COUNT);
    expect(projection.components.javascript).toHaveLength(SCRIPT_COUNT);
    expect(projection.components.native_libraries).toHaveLength(NATIVE_COUNT);
    expect(projection.source_evidence_ids).toHaveLength(3);
    expect(new Set(projection.source_evidence_ids).size).toBe(3);
    // One candidate per script/native pair. Deriving this catches a pairing
    // regression, which the previous literal 10_201 could not.
    expect(projection.bridge_candidates).toHaveLength(
      SCRIPT_COUNT * NATIVE_COUNT,
    );
    expect(projection.coverage).toEqual({
      status: "complete-within-inventory",
      inventory_complete: true,
    });
    expect(projection).not.toHaveProperty("omitted_components");
    expect(projection).not.toHaveProperty("omitted_bridge_candidates");
  });

  it("retains long ZIP application roots when the IPA omits directory entries", async () => {
    const root = await createTestTempDirectory("rea-apple-root-");
    const path = join(root, "Fixture.ipa");
    const applicationRoot = `Payload/${"LongApp".repeat(750)}.app`;
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      `${applicationRoot}/Fixture`,
      new Uint8ArrayReader(
        Uint8Array.from([0xcf, 0xfa, 0xed, 0xfe, 0x0c, 0, 0, 1]),
      ),
    );
    await writeFile(path, await writer.close());

    const inventory = parseEvidence(
      await runProviderAnalysis(path, "inventory_artifact", {}),
    );
    const result = projectAppleApplicationEvidence({
      inventory_evidence: [inventory],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      appleApplicationProjectionResultSchema.parse(
        result.value.normalized_result,
      ),
    ).toMatchObject({
      application_roots: [applicationRoot],
      components: { executables: [expect.any(Object)] },
    });
  });
});
