import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it, onTestFinished } from "vitest";

import { analyzeJavaScriptApplication } from "../../../src/application/javascript/JavaScriptApplicationService.js";
import { exportWebScripts } from "../../../src/application/WebScriptExportService.js";
import { publishWebScripts } from "../../../src/browser/assets/PublishWebScripts.js";
import { selectScriptCapture } from "../../../src/browser/assets/ScriptCaptureAdapters.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { webScriptExportResultSchema } from "../../../src/domain/webScriptExport.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  scriptCaptureEvidenceFixture,
  scriptScenarioFixture,
} from "../../fixtures/webScriptCapture.js";

const setup = async (capture: unknown = scriptCaptureEvidenceFixture()) => {
  const root = await createTestTempDirectory("rea-web-script-export-");
  const input = {
    capture_path: join(root, "capture.json"),
    output_directory: join(root, "export"),
  };
  await writeFile(input.capture_path, JSON.stringify(capture));
  return { root, input };
};

describe("captured script publication boundary", () => {
  it("verifies durable bytes, manifest, capture identity, and existing module analysis", async () => {
    const capture = scriptScenarioFixture([
      {
        url: "https://fixture.test/app/main.js",
        bytes: Buffer.from(
          "import { marker } from './lib/dep.js'; export const result = marker;\n",
        ),
      },
      {
        url: "https://fixture.test/app/lib/dep.js",
        bytes: Buffer.from("export const marker = 'source-owned';\n"),
      },
    ]);
    const { input } = await setup(capture);
    const exported = await exportWebScripts(input);
    if (!exported.ok) throw exported.error;
    const result = webScriptExportResultSchema.parse(
      exported.value.normalized_result,
    );
    expect(result.capture_sha256).toBe(
      createHash("sha256")
        .update(await readFile(input.capture_path))
        .digest("hex"),
    );
    const manifest = await readFile(result.manifest.path);
    expect(result.manifest.sha256).toBe(
      createHash("sha256").update(manifest).digest("hex"),
    );
    const { manifest: descriptor, ...inline } = result;
    expect(descriptor.bytes).toBe(manifest.length);
    expect(JSON.parse(manifest.toString())).toEqual(inline);
    if (result.analysis_input === null)
      throw new Error("Missing analysis input");
    for (const [index, script] of result.scripts.entries()) {
      if (script.content.state !== "exported")
        throw new Error("Expected exported script");
      const bytes = await readFile(
        join(result.analysis_input.input_path, script.content.relative_path),
      );
      expect(bytes).toEqual(
        capture.events.items
          .filter(({ kind }) => kind === "network-content")
          .map((event) =>
            event.kind === "network-content" && event.body.state === "captured"
              ? Buffer.from(event.body.content, "base64")
              : Buffer.alloc(0),
          )[index],
      );
    }
    const analyzed = await analyzeJavaScriptApplication(result.analysis_input);
    if (!analyzed.ok) throw analyzed.error;
    const analysis = javascriptApplicationAnalysisResultSchema.parse(
      analyzed.value.normalized_result,
    );
    expect(analysis.statistics.parsed_javascript_files).toBe(2);
    expect(analysis.graph.edges).toContainEqual(
      expect.objectContaining({
        relation: "imports",
        properties: expect.objectContaining({
          specifier: "./lib/dep.js",
          resolution_status: "resolved",
        }),
      }),
    );
  });

  it("links authenticated input Evidence and preserves binary and empty source bytes", async () => {
    const { input } = await setup();
    const result = await exportWebScripts(input);
    if (!result.ok) throw result.error;
    expect(result.value.evidence_links).toEqual([
      scriptCaptureEvidenceFixture().evidence_id,
    ]);
    const binary = Buffer.from([255, 0, 254, 1]);
    const { input: binaryInput } = await setup(
      scriptScenarioFixture([
        { url: "https://fixture.test/binary.js", bytes: binary },
        { url: "https://fixture.test/empty.js", bytes: Buffer.alloc(0) },
      ]),
    );
    const binaryExport = await exportWebScripts(binaryInput);
    if (!binaryExport.ok) throw binaryExport.error;
    const parsed = webScriptExportResultSchema.parse(
      binaryExport.value.normalized_result,
    );
    const [first, second] = parsed.scripts;
    if (
      first?.content.state !== "exported" ||
      second?.content.state !== "exported" ||
      parsed.analysis_input === null
    )
      throw new Error("Missing exported bytes");
    expect(
      await readFile(
        join(parsed.analysis_input.input_path, first.content.relative_path),
      ),
    ).toEqual(binary);
    expect(
      await readFile(
        join(parsed.analysis_input.input_path, second.content.relative_path),
      ),
    ).toHaveLength(0);
  });

  it("retains missing sources in a manifest without inventing an analysis directory", async () => {
    const capture = scriptScenarioFixture();
    capture.events.items = capture.events.items.filter(
      ({ kind }) => kind !== "network-content",
    );
    capture.events.retained = capture.events.items.length;
    const { input } = await setup(capture);
    const result = await exportWebScripts(input);
    if (!result.ok) throw result.error;
    const parsed = webScriptExportResultSchema.parse(
      result.value.normalized_result,
    );
    expect(parsed.analysis_input).toBeNull();
    expect(parsed.scripts[0]?.content.state).toBe("unavailable");
    expect(await readdir(input.output_directory)).toEqual(["manifest.json"]);
  });
});

describe("captured script publication failures and cleanup", () => {
  it("preserves adapter-reported limitations without strengthening their string contract", async () => {
    const { input } = await setup();
    const capture = {
      ...selectScriptCapture(scriptScenarioFixture()),
      limitations: ["", "producer-reported limitation"],
    };
    const result = await publishWebScripts(input, capture, "a".repeat(64));
    expect(result.limitations.slice(0, 2)).toEqual(capture.limitations);
  });

  it.each([
    Buffer.from("{"),
    Buffer.from([255, 254]),
    Buffer.from(JSON.stringify({ unsupported: true })),
  ])(
    "rejects malformed capture bytes before creating output",
    async (bytes) => {
      const { input } = await setup();
      await writeFile(input.capture_path, bytes);
      const result = await exportWebScripts(input);
      if (result.ok) throw new Error("Expected invalid input");
      expect(result.error._tag).toBe("AnalysisInputError");
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("preserves an existing destination and refuses output through a symlink", async () => {
    const { root, input } = await setup();
    const marker = join(root, "marker.js");
    await writeFile(marker, "keep");
    await symlink(
      root,
      input.output_directory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await exportWebScripts(input);
    if (result.ok) throw new Error("Expected exclusive output failure");
    expect(result.error.userMessage).toContain("already exists");
    expect(await readFile(marker, "utf8")).toBe("keep");
  });

  it("rolls back only the new owned output when durable byte verification fails", async () => {
    const { root, input } = await setup();
    const capture = selectScriptCapture(
      scriptScenarioFixture([
        { url: "https://fixture.test/a.js", bytes: Buffer.from("first") },
        { url: "https://fixture.test/b.js", bytes: Buffer.from("second") },
      ]),
    );
    const second = capture.scripts[1];
    if (second?.content.state !== "captured") throw new Error("Missing source");
    const broken = {
      ...capture,
      scripts: [
        capture.scripts[0],
        { ...second, content: { ...second.content, sha256: "0".repeat(64) } },
      ].filter((value) => value !== undefined),
    };
    await expect(
      publishWebScripts(input, broken, "a".repeat(64)),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(await readdir(root)).toEqual(["capture.json"]);
  });

  it("cancels before work and rolls back cancellation after output creation", async () => {
    const { root, input } = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await exportWebScripts(input, { signal: controller.signal });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    await expect(
      publishWebScripts(
        input,
        selectScriptCapture(scriptScenarioFixture()),
        "a".repeat(64),
        controller.signal,
      ),
    ).rejects.toBeDefined();
    expect(await readdir(root)).toEqual(["capture.json"]);
  });

  it("identifies a missing capture file and rejected host path syntax", async () => {
    const { input } = await setup();
    const missing = await exportWebScripts({
      ...input,
      capture_path: `${input.capture_path}.missing`,
    });
    if (missing.ok) throw new Error("Expected unavailable input");
    expect(projectAnalysisError(missing.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["capture_path"],
            reason: "invalid_value",
            message: expect.stringContaining(`${input.capture_path}.missing`),
          },
        ],
      },
    });
    const relative = await exportWebScripts({
      ...input,
      capture_path: "capture.json",
    });
    if (relative.ok) throw new Error("Expected host path error");
    expect(relative.error._tag).toBe("AnalysisInputError");
  });
});

describe("captured script selection failures", () => {
  it("accepts a capture symlink to a regular file and preserves its selected path", async () => {
    const { root, input } = await setup();
    const selected = join(root, "selected-capture.json");
    await symlink(input.capture_path, selected, "file");

    const result = await exportWebScripts({ ...input, capture_path: selected });
    if (!result.ok) throw result.error;
    expect(result.value.subject?.local_path).toBe(selected);
    expect(
      webScriptExportResultSchema.parse(result.value.normalized_result)
        .capture_sha256,
    ).toBe(
      createHash("sha256")
        .update(await readFile(input.capture_path))
        .digest("hex"),
    );
    await expect(
      access(join(input.output_directory, "manifest.json")),
    ).resolves.toBeUndefined();
  });

  it
    .skipIf(process.platform === "win32")
    .each(["a named pipe", "a symlink to a named pipe"])(
    "rejects %s without waiting for a writer or creating output",
    async (kind) => {
      const { root, input } = await setup();
      const fifoPath = join(root, "capture.pipe");
      await promisify(execFile)("mkfifo", [fifoPath]);
      const selected =
        kind === "a named pipe"
          ? fifoPath
          : join(root, "selected-capture.json");
      if (selected !== fifoPath) await symlink(fifoPath, selected, "file");

      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        exportWebScripts({ ...input, capture_path: selected }),
      );
      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed")
        throw new Error("Capture read waited for a FIFO writer");
      if (outcome.result.ok)
        throw new Error("Expected invalid capture selection");
      expect(projectAnalysisError(outcome.result.error)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["capture_path"],
              reason: "invalid_value",
              message: expect.stringContaining("regular file"),
            },
          ],
        },
      });
      expect(
        JSON.stringify(projectAnalysisError(outcome.result.error)),
      ).toContain(selected);
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a character device as a capture selection before parsing bytes",
    async () => {
      const { input } = await setup();
      const result = await exportWebScripts({
        ...input,
        capture_path: "/dev/null",
      });
      if (result.ok) throw new Error("Expected invalid capture selection");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "invalid_request",
        details: {
          issues: [
            {
              path: ["capture_path"],
              reason: "invalid_value",
              message: expect.stringContaining("regular file"),
            },
          ],
        },
      });
      expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
        "/dev/null",
      );
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "honors a pre-aborted capture export before opening a named pipe",
    async () => {
      const { root, input } = await setup();
      const fifoPath = join(root, "capture.pipe");
      await promisify(execFile)("mkfifo", [fifoPath]);
      const controller = new AbortController();
      controller.abort();

      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        exportWebScripts(
          { ...input, capture_path: fifoPath },
          { signal: controller.signal },
        ),
      );
      expect(outcome.state).toBe("completed");
      if (outcome.state !== "completed")
        throw new Error("Aborted capture read waited for a FIFO writer");
      if (outcome.result.ok) throw new Error("Expected cancellation");
      expect(outcome.result.error._tag).toBe("AnalysisCancelledError");
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );
});

describe("captured script path and permission failures", () => {
  it("reports a directory selected as the capture as invalid input", async () => {
    const { root, input } = await setup();
    const directory = join(root, "captures");
    await mkdir(directory);

    const result = await exportWebScripts({
      ...input,
      capture_path: directory,
    });
    if (result.ok) throw new Error("Expected invalid input");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["capture_path"],
            reason: "invalid_value",
            message: expect.stringContaining(directory),
          },
        ],
      },
    });
    await expect(access(input.output_directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "reports an unreadable capture as a host access denial",
    async () => {
      const { input } = await setup();
      await chmod(input.capture_path, 0o000);
      onTestFinished(() => chmod(input.capture_path, 0o600));

      const result = await exportWebScripts(input);
      if (result.ok) throw new Error("Expected access denial");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "access_denied",
        details: { path: input.capture_path, system_code: "EACCES" },
      });
    },
  );
});
