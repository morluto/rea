import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createNativeExportsService } from "../../../src/composition/binaryDiagnostics.js";
import { parseEvidence } from "../../../src/domain/evidence.js";
import { nativeExportsSchema } from "../../../src/domain/native/nativeExports.js";
import { elfDynamicExportsImage } from "../../fixtures/binaryDiagnostics/elfDynamicExports.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

describe("sectionless ELF export filesystem boundary", () => {
  it("binds a dynamic export inventory to the selected file and recovers after a malformed table", async () => {
    const root = await createTestTempDirectory("rea-sectionless-exports-");
    const path = join(root, "libsectionless.so");
    const malformedPath = join(root, "libmalformed.so");
    const bytes = elfDynamicExportsImage({ hash: "both" });
    const malformed = Buffer.from(bytes);
    // SysV nchain disagrees with the complete GNU bucket/chain inventory.
    malformed.writeUInt32LE(2, 0x304);
    await writeFile(path, bytes);
    await writeFile(malformedPath, malformed);
    const service = createNativeExportsService();
    try {
      const rejected = await service.inspect({ path: malformedPath });
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisInputError",
          operation: "inspect_native_exports",
          issues: [{ path: ["path"], reason: "invalid_format" }],
        },
      });

      const result = await service.inspect({ path });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      const evidence = parseEvidence(result.value);
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      expect(evidence).toMatchObject({
        operation: "inspect_native_exports",
        provider: { id: "rea-native-exports" },
        confidence: "observed",
        subject: { local_path: path, format: "elf", digest: { sha256 } },
      });
      expect(
        nativeExportsSchema.parse(evidence.normalized_result),
      ).toMatchObject({
        artifact: { path, sha256, bytes: bytes.length },
        exports: [{ name: "exported_answer" }, { name: "exported_state" }],
        coverage: { status: "complete", examined_entries: 2, exports: 2 },
        issues: [],
      });
      expect((await readFile(path)).equals(bytes)).toBe(true);
      expect((await readFile(malformedPath)).equals(malformed)).toBe(true);
    } finally {
      await service.close();
    }
  });
});
