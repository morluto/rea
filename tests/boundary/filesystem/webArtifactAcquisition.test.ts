import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { LocalWebScriptArtifacts } from "../../../src/browser/assets/LocalWebScriptArtifacts.js";
import { LocalWebModuleArtifacts } from "../../../src/browser/modules/WebModuleArtifacts.js";
import { LocalWebSourceLocationArtifacts } from "../../../src/browser/assets/WebSourceLocationArtifacts.js";
import { webArtifactAcquisitionSchema } from "../../../src/domain/webArtifactAcquisition.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { webModuleArtifactsFixture } from "../../fixtures/webModuleTrace.js";

const identity = (path: string, bytes: Buffer) => ({
  path,
  sha256: createHash("sha256").update(bytes).digest("hex"),
  bytes: bytes.length,
});

it.each([
  "invalid-json",
  "invalid-utf8",
  "invalid-schema",
  "missing-selection",
  "source-mismatch",
  "missing-map",
  "invalid-import-map",
])(
  "retains independently read web file identities when %s prevents analysis",
  async (variant) => {
    const root = await createTestTempDirectory("rea-web-acquisition-");
    const fixture = webModuleArtifactsFixture();
    const manifestPath = join(root, "manifest.json");
    const sourcePath = join(root, "files", "modules", "main.js");
    await mkdir(join(root, "files", "modules"), { recursive: true });
    const source = Buffer.from(
      variant === "source-mismatch" ? "changed" : fixture.source,
    );
    await writeFile(sourcePath, source);
    const manifest =
      variant === "invalid-json"
        ? Buffer.from("{")
        : variant === "invalid-utf8"
          ? Buffer.from([255])
          : variant === "invalid-schema"
            ? Buffer.from("{}")
            : Buffer.from(JSON.stringify(fixture.manifest));
    await writeFile(manifestPath, manifest);
    const reader =
      variant === "missing-map"
        ? new LocalWebSourceLocationArtifacts()
        : variant === "invalid-import-map"
          ? new LocalWebModuleArtifacts()
          : new LocalWebScriptArtifacts("trace_web_module_imports");
    onTestFinished(() => reader.close());
    const input = {
      manifest_path: manifestPath,
      script_index: variant === "missing-selection" ? 100 : 0,
    };
    const mapPath = join(root, "selected.map");
    if (variant === "invalid-import-map") await writeFile(mapPath, "[]");
    const result =
      reader instanceof LocalWebSourceLocationArtifacts
        ? await reader.load({
            ...input,
            source_map: { path: mapPath, url: "https://app.test/app.map" },
            generated_position: { line: 1, column: 0 },
          })
        : reader instanceof LocalWebModuleArtifacts
          ? await reader.load({
              ...input,
              import_map: { path: mapPath, base_url: "https://app.test/" },
            })
          : await reader.load(input);
    if (result.ok) throw new Error("Expected acquisition failure");
    const projected = projectAnalysisError(result.error);
    if (variant === "missing-map")
      expect(projected).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["source_map", "path"],
              reason: "invalid_value",
              message: expect.stringContaining(`(ENOENT): ${mapPath}`),
            },
          ],
        },
      });
    if (variant === "source-mismatch")
      expect(projected).toMatchObject({
        category: "integrity_mismatch",
        details: { integrity_check: "member-identity" },
      });
    const observation = webArtifactAcquisitionSchema.parse(
      projected.details?.partial_observation,
    );
    const files = [
      {
        role: "manifest",
        file: identity(manifestPath, manifest),
        admission:
          variant.startsWith("invalid-") && variant !== "invalid-import-map"
            ? "read"
            : "manifest-validated",
      },
    ];
    if (
      ["source-mismatch", "missing-map", "invalid-import-map"].includes(variant)
    )
      files.push({
        role: "source",
        file: identity(sourcePath, source),
        admission: variant === "source-mismatch" ? "read" : "source-verified",
      });
    if (variant === "invalid-import-map")
      files.push({
        role: "import-map",
        file: identity(mapPath, Buffer.from("[]")),
        admission: "read",
      });
    expect(observation).toEqual({
      kind: "web-artifact-acquisition",
      analysis: "not-performed",
      files,
    });
  },
);
