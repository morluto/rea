import { createHash } from "node:crypto";
import { chmod, mkdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { exportWebScripts } from "../../../src/application/WebScriptExportService.js";
import { ArtifactResourceScope } from "../../../src/resources/ArtifactResourceScope.js";
import { LocalWebScriptArtifacts } from "../../../src/browser/assets/LocalWebScriptArtifacts.js";
import { LocalWebModuleArtifacts } from "../../../src/browser/modules/WebModuleArtifacts.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { webScriptExportResultSchema } from "../../../src/domain/webScriptExport.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { scriptScenarioFixture } from "../../fixtures/webScriptCapture.js";

const fixture = async (bytes = Buffer.from('import "./dep.js";')) => {
  const root = await createTestTempDirectory("rea-module-artifacts-");
  const capturePath = join(root, "capture.json");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  await writeFile(
    capturePath,
    JSON.stringify(
      scriptScenarioFixture([{ url: "https://app.test/main.js", bytes }]),
    ),
  );
  const response = await exportWebScripts(
    {
      capture_path: capturePath,
      output_directory: join(root, "export"),
    },
    resources,
  );
  if (!response.ok) throw response.error;
  const result = webScriptExportResultSchema.parse(
    response.value.normalized_result,
  );
  const script = result.scripts[0];
  if (script?.content.state !== "exported")
    throw new Error("fixture needs source");
  const { manifest: manifestFile, ...manifest } = result;
  return {
    root,
    manifest,
    manifestFile,
    script,
    content: script.content,
    manifestPath: manifestFile.path,
    sourcePath: join(
      result.output_directory,
      "files",
      script.content.relative_path,
    ),
  };
};

describe("selected captured module artifact boundary", () => {
  it("verifies relocated source identity before accepting the captured bytes", async () => {
    const source = 'import "./dep.js";';
    const f = await fixture(Buffer.from(source));
    const relocated = join(f.root, "relocated");
    await rename(f.manifest.output_directory, relocated);
    const sourcePath = join(relocated, "files", f.content.relative_path);
    const input = {
      manifest_path: join(relocated, "manifest.json"),
      script_index: 0,
    };
    const artifacts = new LocalWebModuleArtifacts();
    onTestFinished(() => artifacts.close());
    const identity = (text: string) => ({
      path: sourcePath,
      sha256: createHash("sha256").update(text).digest("hex"),
      bytes: Buffer.byteLength(text),
    });
    const response = await artifacts.load(input);
    if (!response.ok) throw response.error;
    expect(response.value).toMatchObject({
      source,
      sourceFile: identity(source),
      manifest: { output_directory: f.manifest.output_directory },
      importMap: null,
    });

    for (const [bytes, declaredBytes] of [
      ['import "./alt.js";', identity(source).bytes],
      [source, identity(source).bytes + 1],
    ] as const) {
      f.content.bytes = declaredBytes;
      await writeFile(input.manifest_path, JSON.stringify(f.manifest));
      await writeFile(sourcePath, bytes);
      const mismatch = await artifacts.load(input);
      if (mismatch.ok) throw new Error("accepted a different source identity");
      expect(projectAnalysisError(mismatch.error)).toMatchObject({
        code: "artifact_integrity_mismatch",
        details: {
          integrity_check: "member-identity",
          declared_sha256: identity(source).sha256,
          calculated_sha256: identity(bytes).sha256,
        },
      });
      expect(mismatch.error.partialObservation).toMatchObject({
        files: [
          { role: "manifest", admission: "manifest-validated" },
          { role: "source", admission: "read", file: identity(bytes) },
        ],
      });
    }
  });

  it("attributes invalid UTF-8 to the source artifact in both workflows", async () => {
    const f = await fixture(Buffer.from([255, 254]));
    for (const operation of [
      "trace_web_module_imports",
      "trace_web_source_location",
    ] as const) {
      const artifacts = new LocalWebScriptArtifacts(operation);
      onTestFinished(() => artifacts.close());
      const response = await artifacts.load({
        manifest_path: f.manifestPath,
        script_index: 0,
      });
      if (response.ok) throw new Error("expected invalid source bytes");
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "artifact_operation_failed",
        details: {
          operation,
          reason: "format",
          detail: expect.stringContaining(f.sourcePath),
        },
      });
    }
  });
  it("rejects source links and manifest traversal across containment boundaries", async () => {
    const f = await fixture();
    const artifacts = new LocalWebModuleArtifacts();
    onTestFinished(() => artifacts.close());
    const input = { manifest_path: f.manifestPath, script_index: 0 };
    const original = dirname(f.sourcePath);
    const exportRoot = f.manifest.output_directory;
    const links = [
      [f.sourcePath, join(f.root, "outside.js"), "file"],
      [f.sourcePath, join(exportRoot, "original.js"), "file"],
      [original, join(exportRoot, "original-directory"), "dir"],
    ] as const;
    for (const [path, target, type] of links) {
      await rename(path, target);
      await symlink(target, path, type);
      const response = await artifacts.load(input);
      if (response.ok) throw new Error(`accepted a source ${type} symlink`);
      expect(response.error).toMatchObject({
        _tag: "ArtifactOperationError",
        reason: "path",
      });
      await rm(path);
      await rename(target, path);
    }
    f.content.relative_path = "../capture.json";
    await writeFile(f.manifestPath, JSON.stringify(f.manifest));
    const escaped = await artifacts.load(input);
    if (escaped.ok) throw new Error("expected malformed source path");
    expect(projectAnalysisError(escaped.error)).toMatchObject({
      code: "artifact_operation_failed",
      details: {
        operation: "trace_web_module_imports",
        reason: "path",
        detail: expect.stringContaining("../capture.json"),
      },
    });
  });
});

describe("caller-selected web module files", () => {
  it("keeps completed source reads when the selected import map is missing or malformed", async () => {
    const f = await fixture();
    const artifacts = new LocalWebModuleArtifacts();
    onTestFinished(() => artifacts.close());
    const path = join(f.root, "map.json");
    const baseUrl = "https://map.test/base/";
    const input = {
      manifest_path: f.manifestPath,
      script_index: 0,
      import_map: { path, base_url: baseUrl },
    };
    const selected = { imports: { blocked: null } };
    for (const [contents, reason] of [
      [null, "invalid_value"],
      ["[]", "invalid_format"],
    ] as const) {
      if (contents !== null) await writeFile(path, contents);
      const response = await artifacts.load(input);
      if (response.ok) throw new Error(`admitted map with ${reason}`);
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: ["import_map", "path"], reason }] },
      });
      const files = [
        {
          role: "manifest",
          admission: "manifest-validated",
          file: f.manifestFile,
        },
        {
          role: "source",
          admission: "source-verified",
          file: { path: f.sourcePath },
        },
      ];
      if (contents !== null)
        files.push({ role: "import-map", admission: "read", file: { path } });
      expect(response.error.partialObservation).toMatchObject({ files });
    }

    await writeFile(path, JSON.stringify(selected));
    const response = await artifacts.load(input);
    if (!response.ok) throw response.error;
    expect(response.value.importMap).toMatchObject({
      baseUrl,
      value: selected,
    });
  });

  it("reports a missing or non-file manifest selection as invalid input", async () => {
    const root = await createTestTempDirectory("rea-module-missing-");
    const missing = join(root, "missing.json");
    const directory = join(root, "directory");
    await mkdir(directory);
    for (const manifest_path of [
      missing,
      join(missing, "manifest.json"),
      directory,
    ]) {
      const response = await new LocalWebModuleArtifacts().load({
        manifest_path,
        script_index: 0,
      });
      if (response.ok) throw new Error("expected selection failure");
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["manifest_path"],
              reason: "invalid_value",
              message: expect.stringContaining(manifest_path),
            },
          ],
        },
      });
    }
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable manifest as a host access denial",
    async () => {
      const { manifestPath } = await fixture();
      await chmod(manifestPath, 0o000);
      onTestFinished(() => chmod(manifestPath, 0o600));
      const response = await new LocalWebModuleArtifacts().load({
        manifest_path: manifestPath,
        script_index: 0,
      });
      if (response.ok) throw new Error("expected access denial");
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "access_denied",
        details: { path: manifestPath, system_code: "EACCES" },
      });
    },
  );

  it("keeps a missing manifest-derived source as an artifact fault", async () => {
    const { manifestPath, sourcePath } = await fixture();
    await rm(sourcePath);
    const response = await new LocalWebModuleArtifacts().load({
      manifest_path: manifestPath,
      script_index: 0,
    });
    if (response.ok) throw new Error("expected missing source");
    expect(response.error).toMatchObject({
      _tag: "ArtifactOperationError",
      reason: "io",
      cause: expect.objectContaining({ code: "ENOENT" }),
    });
    expect(projectAnalysisError(response.error)).toMatchObject({
      details: { detail: expect.stringContaining(`${sourcePath}:`) },
    });
    expect(projectAnalysisError(response.error).details?.detail).not.toMatch(
      /^script_index:/u,
    );
  });
});

describe("selected captured script index", () => {
  it("distinguishes an out-of-range index, unavailable source, empty and malformed manifests", async () => {
    const f = await fixture();
    f.script.content = {
      state: "unavailable",
      reason: "not-captured",
      message: "Source bytes were not selected in this capture.",
    };
    const artifacts = new LocalWebModuleArtifacts();
    onTestFinished(() => artifacts.close());
    const input = { manifest_path: f.manifestPath, script_index: 0 };
    const singleScript = JSON.stringify(f.manifest);
    await writeFile(f.manifestPath, singleScript);
    const unavailable = await artifacts.load(input);
    if (unavailable.ok) throw new Error("expected unavailable source");
    expect(projectAnalysisError(unavailable.error)).toMatchObject({
      code: "capability_unavailable",
      details: { reason: "selected_source_unavailable" },
    });

    for (const [text, index, field, issue] of [
      [
        singleScript,
        5,
        "script_index",
        { reason: "out_of_range", minimum: 0, maximum: 0 },
      ],
      [
        JSON.stringify({ ...f.manifest, scripts: [] }),
        0,
        "script_index",
        { reason: "invalid_value" },
      ],
      ["{", 0, "manifest_path", { reason: "invalid_format" }],
    ] as const) {
      await writeFile(f.manifestPath, text);
      const response = await artifacts.load({ ...input, script_index: index });
      if (response.ok) throw new Error(`unexpected ${issue.reason} acceptance`);
      expect(projectAnalysisError(response.error)).toMatchObject({
        code: "invalid_request",
        details: { issues: [{ path: [field], ...issue }] },
      });
    }
  });
});
