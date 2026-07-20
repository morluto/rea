import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  TextReader,
  Uint8ArrayReader,
  Uint8ArrayWriter,
  ZipWriter,
} from "@zip.js/zip.js";
import { describe, expect, it } from "vitest";

import { projectAppleApplicationEvidence } from "../src/application/AppleApplicationService.js";
import { runProviderAnalysis } from "../src/application/DirectAnalysis.js";
import { appleApplicationProjectionResultSchema } from "../src/domain/appleApplication.js";
import { parseEvidence } from "../src/domain/evidence.js";

describe("Apple application projection", () => {
  it("projects deterministic IPA components and bridge hypotheses from exact inventory Evidence", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-apple-"));
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
      await runProviderAnalysis(path, "inventory_artifact", {
        node_limit: 500,
        occurrence_limit: 500,
        edge_limit: 500,
      }),
    );
    const first = projectAppleApplicationEvidence({
      inventory_evidence: [inventory],
      limits: { max_components: 100 },
    });
    const second = projectAppleApplicationEvidence({
      inventory_evidence: [inventory],
      limits: { max_components: 100 },
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
        omitted_components: 0,
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
      expect.objectContaining({ basis: "react-native-convention" }),
    ]);
    expect(JSON.stringify(left)).not.toContain("opaque signing bytes");
  });

  it("rejects non-IPA Evidence and reports projection truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-apple-invalid-"));
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

  it("infers an application root when the IPA omits directory entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "rea-apple-root-"));
    const path = join(root, "Fixture.ipa");
    const writer = new ZipWriter(new Uint8ArrayWriter());
    await writer.add(
      "Payload/Fixture.app/Fixture",
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
      application_roots: ["Payload/Fixture.app"],
      components: { executables: [expect.any(Object)] },
    });
  });
});
