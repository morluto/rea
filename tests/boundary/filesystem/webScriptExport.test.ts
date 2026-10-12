import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  open as fsOpen,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  onTestFinished,
  vi,
} from "vitest";

import { analyzeJavaScriptApplication } from "../../support/javascriptApplicationScope.js";
import { exportWebScripts } from "../../../src/application/WebScriptExportService.js";
import { ArtifactResourceScope } from "../../../src/artifacts/ArtifactResourceScope.js";
import { publishWebScripts } from "../../../src/browser/assets/PublishWebScripts.js";
import { SafeOutputTree } from "../../../src/artifacts/SafeOutputTree.js";
import { SafeOutputTreeCreationFailure } from "../../../src/artifacts/SafeOutputTreeCreationFailure.js";
import { selectScriptCapture } from "../../../src/browser/assets/ScriptCaptureAdapters.js";
import { javascriptApplicationAnalysisResultSchema } from "../../../src/domain/javascript/javascriptApplicationAnalysis.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION } from "../../../src/domain/browserNetworkEvidence.js";
import {
  webScriptExportManifestSchema,
  webScriptExportResultSchema,
} from "../../../src/domain/webScriptExport.js";
import { readWithoutFifoWriter } from "../../fixtures/fifoInput.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import {
  scriptCaptureEvidenceFixture,
  scriptScenarioFixture,
} from "../../fixtures/webScriptCapture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

const openMock = vi.mocked(fsOpen);
let actualFs: typeof import("node:fs/promises");

beforeEach(async () => {
  actualFs =
    await vi.importActual<typeof import("node:fs/promises")>(
      "node:fs/promises",
    );
  openMock.mockImplementation((...args) => actualFs.open(...args));
});

afterEach(() => openMock.mockReset());

const setup = async (capture: unknown = scriptCaptureEvidenceFixture()) => {
  const root = await createTestTempDirectory("rea-web-script-export-");
  const resources = new ArtifactResourceScope();
  onTestFinished(() => resources.close());
  const input = {
    capture_path: join(root, "capture.json"),
    output_directory: join(root, "export"),
  };
  await writeFile(input.capture_path, JSON.stringify(capture));
  return { root, input, resources };
};

describe("empty URL component publication", () => {
  it("isolates empty query and fragment identities while retaining durable script bytes", async () => {
    const scripts = [
      {
        url: "https://fixture.test/ordinary.js",
        bytes: Buffer.from("export const ordinary = 1;"),
      },
      {
        url: "https://fixture.test/query.js?",
        bytes: Buffer.from("export const query = 2;"),
      },
      {
        url: "https://fixture.test/fragment.js#",
        bytes: Buffer.from("export const fragment = 3;"),
      },
    ];
    const { input, resources } = await setup(scriptScenarioFixture(scripts));
    const exported = await exportWebScripts(input, resources);
    if (!exported.ok) throw exported.error;
    const result = webScriptExportResultSchema.parse(
      exported.value.normalized_result,
    );
    if (result.analysis_input === null)
      throw new Error("Missing analysis input");
    for (const [index, script] of result.scripts.entries()) {
      if (script.content.state !== "exported")
        throw new Error("Missing source bytes");
      expect(script.url).toBe(scripts[index]?.url);
      expect(script.content.layout).toBe(index === 0 ? "url-path" : "isolated");
      expect(
        await readFile(
          join(result.analysis_input.input_path, script.content.relative_path),
        ),
      ).toEqual(scripts[index]?.bytes);
    }
    const manifest = JSON.parse(await readFile(result.manifest.path, "utf8"));
    expect(manifest.scripts).toEqual(result.scripts);
  });
});

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
    const { input, resources } = await setup(capture);
    const exported = await exportWebScripts(input, resources);
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

  it("links authenticated input Evidence", async () => {
    const { input, resources } = await setup();
    const result = await exportWebScripts(input, resources);
    if (!result.ok) throw result.error;
    expect(result.value.evidence_links).toEqual([
      scriptCaptureEvidenceFixture().evidence_id,
    ]);
  });

  it.each([
    "playwright-response-body-bytes",
    "browser-decoded-response-bytes",
  ] as const)(
    "preserves binary and empty response bytes and provenance for %s",
    async (representation) => {
      const binary = Buffer.from([255, 0, 254, 1]);
      const capture = scriptScenarioFixture([
        { url: "https://fixture.test/binary.js", bytes: binary },
        { url: "https://fixture.test/empty.js", bytes: Buffer.alloc(0) },
      ]);
      for (const event of capture.events.items) {
        if (event.kind === "network-content" && event.body.state === "captured")
          event.body.representation = representation;
      }
      const { input: binaryInput, resources: binaryResources } =
        await setup(capture);
      const binaryExport = await exportWebScripts(binaryInput, binaryResources);
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
      expect(first.content.representation).toBe(representation);
      expect(second.content.representation).toBe(representation);
      expect(parsed.limitations).toContain(
        PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION,
      );
      const persisted = webScriptExportManifestSchema.parse(
        JSON.parse(await readFile(parsed.manifest.path, "utf8")),
      );
      expect(
        persisted.scripts.map(({ content }) =>
          content.state === "exported" ? content.representation : undefined,
        ),
      ).toEqual([representation, representation]);
      expect(persisted.limitations).toContain(
        PLAYWRIGHT_RESPONSE_BODY_PROVENANCE_LIMITATION,
      );
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
    },
  );

  it("retains missing sources in a manifest without inventing an analysis directory", async () => {
    const capture = scriptScenarioFixture();
    capture.events.items = capture.events.items.filter(
      ({ kind }) => kind !== "network-content",
    );
    capture.events.retained = capture.events.items.length;
    const { input, resources } = await setup(capture);
    const result = await exportWebScripts(input, resources);
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
    const { input, resources } = await setup();
    const capture = {
      ...selectScriptCapture(scriptScenarioFixture()),
      limitations: ["", "producer-reported limitation"],
    };
    const result = await publishWebScripts(input, capture, "a".repeat(64), {
      resources,
    });
    expect(result.limitations.slice(0, 2)).toEqual(capture.limitations);
  });

  it.each([
    Buffer.from("{"),
    Buffer.from([255, 254]),
    Buffer.from(JSON.stringify({ unsupported: true })),
  ])(
    "rejects malformed capture bytes before creating output",
    async (bytes) => {
      const { input, resources } = await setup();
      await writeFile(input.capture_path, bytes);
      const result = await exportWebScripts(input, resources);
      if (result.ok) throw new Error("Expected invalid input");
      expect(result.error._tag).toBe("AnalysisInputError");
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("preserves an existing destination and refuses output through a symlink", async () => {
    const { root, input, resources } = await setup();
    const marker = join(root, "marker.js");
    await writeFile(marker, "keep");
    await symlink(
      root,
      input.output_directory,
      process.platform === "win32" ? "junction" : "dir",
    );
    const result = await exportWebScripts(input, resources);
    if (result.ok) throw new Error("Expected exclusive output failure");
    expect(result.error.userMessage).toContain("already exists");
    expect(await readFile(marker, "utf8")).toBe("keep");
  });

  it("rolls back only the new owned output when durable byte verification fails", async () => {
    const { root, input, resources } = await setup();
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
      publishWebScripts(input, broken, "a".repeat(64), { resources }),
    ).rejects.toMatchObject({ reason: "integrity" });
    expect(await readdir(root)).toEqual(["capture.json"]);
  });
});

describe("captured script output owner retry", () => {
  it("retains a setup-failed output tree in the caller resource scope", async () => {
    const { input, resources } = await setup();
    const capture = selectScriptCapture(scriptScenarioFixture());
    const createTree = SafeOutputTree.create.bind(SafeOutputTree);
    let cleanupAttempts = 0;
    const create = vi
      .spyOn(SafeOutputTree, "create")
      .mockImplementationOnce(async (outputRoot, platform) => {
        const tree = await createTree(outputRoot, platform);
        const rollbackTree = tree.rollback.bind(tree);
        vi.spyOn(tree, "rollback").mockImplementation(async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1)
            throw new Error("injected first cleanup failure");
          return rollbackTree();
        });
        throw new SafeOutputTreeCreationFailure(
          new Error("injected post-acquisition setup failure"),
          tree,
        );
      });
    try {
      await expect(
        publishWebScripts(input, capture, "a".repeat(64), { resources }),
      ).rejects.toMatchObject({ cleanupIncomplete: true });
      await expect(access(input.output_directory)).resolves.toBeUndefined();
    } finally {
      create.mockRestore();
    }
    await resources.close();
    expect(cleanupAttempts).toBe(2);
    await expect(access(input.output_directory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("returns completed output when retry closes a descriptor after commit", async () => {
    const { input, resources } = await setup();
    const createTree = SafeOutputTree.create.bind(SafeOutputTree);
    const create = vi
      .spyOn(SafeOutputTree, "create")
      .mockImplementationOnce(async (outputRoot, platform) => {
        const tree = await createTree(outputRoot, platform);
        const commit = tree.commit.bind(tree);
        vi.spyOn(tree, "commit").mockImplementation(async () => {
          await commit();
          throw new Error("injected descriptor close failure");
        });
        return tree;
      });
    try {
      const result = await exportWebScripts(input, resources);
      if (!result.ok) throw result.error;
      const published = webScriptExportResultSchema.parse(
        result.value.normalized_result,
      );
      expect(published.manifest.path).toBe(
        join(input.output_directory, "manifest.json"),
      );
      await expect(access(published.manifest.path)).resolves.toBeUndefined();
    } finally {
      create.mockRestore();
    }
  });

  it("retains published output and its result while cleanup remains unresolved", async () => {
    const { input, resources } = await setup();
    const createTree = SafeOutputTree.create.bind(SafeOutputTree);
    let cleanupAttempts = 0;
    const create = vi
      .spyOn(SafeOutputTree, "create")
      .mockImplementationOnce(async (outputRoot, platform) => {
        const tree = await createTree(outputRoot, platform);
        const commit = tree.commit.bind(tree);
        vi.spyOn(tree, "commit").mockImplementation(async () => {
          await commit();
          throw new Error("injected descriptor close failure");
        });
        const rollback = tree.rollback.bind(tree);
        vi.spyOn(tree, "rollback").mockImplementation(async () => {
          cleanupAttempts += 1;
          if (cleanupAttempts === 1)
            throw new Error("injected cleanup refusal");
          return rollback();
        });
        return tree;
      });
    try {
      const result = await exportWebScripts(input, resources);
      if (result.ok) throw new Error("Expected unresolved cleanup");
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(result.error.userMessage).not.toContain("Remove the residual");
      expect(result.error.partialObservation).toMatchObject({
        kind: "web-script-export",
        result: {
          output_directory: input.output_directory,
          manifest: { path: join(input.output_directory, "manifest.json") },
        },
      });
      await expect(
        access(join(input.output_directory, "manifest.json")),
      ).resolves.toBeUndefined();
      await resources.close();
      expect(cleanupAttempts).toBe(2);
    } finally {
      create.mockRestore();
    }
  });
});

describe("captured script publication failures and cleanup", () => {
  it("cancels before work and rolls back cancellation after output creation", async () => {
    const { root, input, resources } = await setup();
    const controller = new AbortController();
    controller.abort();
    const result = await exportWebScripts(input, resources, {
      signal: controller.signal,
    });
    if (result.ok) throw new Error("Expected cancellation");
    expect(result.error._tag).toBe("AnalysisCancelledError");
    await expect(
      publishWebScripts(
        input,
        selectScriptCapture(scriptScenarioFixture()),
        "a".repeat(64),
        { resources, signal: controller.signal },
      ),
    ).rejects.toBeDefined();
    expect(await readdir(root)).toEqual(["capture.json"]);
  });

  it("identifies a missing capture file and rejected host path syntax", async () => {
    const { input, resources } = await setup();
    const missing = await exportWebScripts(
      {
        ...input,
        capture_path: `${input.capture_path}.missing`,
      },
      resources,
    );
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
    const relative = await exportWebScripts(
      {
        ...input,
        capture_path: "capture.json",
      },
      resources,
    );
    if (relative.ok) throw new Error("Expected host path error");
    expect(relative.error._tag).toBe("AnalysisInputError");
  });
});

describe("captured script selection failures", () => {
  it("accepts a capture symlink to a regular file and preserves its selected path", async () => {
    const { root, input, resources } = await setup();
    const selected = join(root, "selected-capture.json");
    await symlink(input.capture_path, selected, "file");

    const result = await exportWebScripts(
      { ...input, capture_path: selected },
      resources,
    );
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
      const { root, input, resources } = await setup();
      const fifoPath = join(root, "capture.pipe");
      await promisify(execFile)("mkfifo", [fifoPath]);
      const selected =
        kind === "a named pipe"
          ? fifoPath
          : join(root, "selected-capture.json");
      if (selected !== fifoPath) await symlink(fifoPath, selected, "file");

      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        exportWebScripts({ ...input, capture_path: selected }, resources),
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
      const { input, resources } = await setup();
      const result = await exportWebScripts(
        {
          ...input,
          capture_path: "/dev/null",
        },
        resources,
      );
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
      const { root, input, resources } = await setup();
      const fifoPath = join(root, "capture.pipe");
      await promisify(execFile)("mkfifo", [fifoPath]);
      const controller = new AbortController();
      controller.abort();

      const outcome = await readWithoutFifoWriter(fifoPath, () =>
        exportWebScripts({ ...input, capture_path: fifoPath }, resources, {
          signal: controller.signal,
        }),
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
    const { root, input, resources } = await setup();
    const directory = join(root, "captures");
    await mkdir(directory);

    const result = await exportWebScripts(
      {
        ...input,
        capture_path: directory,
      },
      resources,
    );
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
      const { input, resources } = await setup();
      await chmod(input.capture_path, 0o000);
      onTestFinished(() => chmod(input.capture_path, 0o600));

      const result = await exportWebScripts(input, resources);
      if (result.ok) throw new Error("Expected access denial");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "access_denied",
        details: { path: input.capture_path, system_code: "EACCES" },
      });
    },
  );
});

describe("capture read and close failure", () => {
  it("retains a handle after capture read and close both fail", async () => {
    const { input, resources } = await setup();
    const readFailure = Object.assign(
      new Error("injected capture read failure"),
      { code: "EIO" },
    );
    const closeFailure = new Error("injected capture close failure");
    let openedHandle: Awaited<ReturnType<typeof actualFs.open>> | undefined;
    let closeCalls = 0;
    let allowClose = false;
    openMock.mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (String(args[0]) !== input.capture_path) return handle;
      openedHandle = handle;
      vi.spyOn(handle, "read").mockRejectedValue(readFailure);
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls += 1;
        if (!allowClose) throw closeFailure;
        await close();
      });
      return handle;
    });

    try {
      const result = await exportWebScripts(input, resources);
      if (result.ok) throw new Error("Expected capture read failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: [input.capture_path],
          diagnostics: {
            primary_error: {
              code: "artifact_operation_failed",
              details: { reason: "io" },
            },
          },
        },
      });
      if (openedHandle === undefined)
        throw new Error("Expected the capture handle to be admitted");
      expect(openedHandle.fd).toBeGreaterThanOrEqual(0);
      expect(closeCalls).toBe(2);
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(resources.close()).rejects.toMatchObject({
        cleanup: {
          resources: [input.capture_path],
          reason: expect.stringContaining(closeFailure.message),
        },
      });
      expect(closeCalls).toBe(3);
      allowClose = true;
      await resources.close();
      expect(closeCalls).toBe(4);
      expect(openedHandle.fd).toBe(-1);
    } finally {
      allowClose = true;
      await resources.close().catch(() => undefined);
    }
  });
});

describe("capture handle ownership", () => {
  it("retains the failed handle and keeps invalid JSON primary", async () => {
    const { input, resources } = await setup();
    await writeFile(input.capture_path, "{");
    const closeFailure = new Error("injected capture close failure");
    const closeCalls = new Map<object, number>();
    let allowClose = false;
    openMock.mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (String(args[0]) !== input.capture_path) return handle;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls.set(handle, (closeCalls.get(handle) ?? 0) + 1);
        if (!allowClose) throw closeFailure;
        await close();
      });
      return handle;
    });

    try {
      const result = await exportWebScripts(input, resources);
      if (result.ok) throw new Error("Expected invalid capture failure");
      expect(projectAnalysisError(result.error)).toMatchObject({
        code: "cleanup_incomplete",
        details: {
          resources: [input.capture_path],
          diagnostics: {
            primary_error: {
              code: "invalid_request",
              details: {
                issues: [{ path: ["capture_path"], reason: "invalid_format" }],
              },
            },
          },
        },
      });
      expect([...closeCalls.values()]).toEqual([2]);
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });

      await expect(resources.close()).rejects.toMatchObject({
        cleanup: {
          resources: [input.capture_path],
          reason: expect.stringContaining(closeFailure.message),
        },
      });
      expect([...closeCalls.values()]).toEqual([3]);

      allowClose = true;
      await resources.close();
      expect([...closeCalls.values()]).toEqual([4]);
    } finally {
      allowClose = true;
      await resources.close().catch(() => undefined);
    }
  });

  it("reports a recovered close failure without marking cleanup incomplete", async () => {
    const { input, resources } = await setup();
    await writeFile(input.capture_path, "{");
    const closeFailure = new Error("injected one-time capture close failure");
    let closeCalls = 0;
    openMock.mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (String(args[0]) !== input.capture_path) return handle;
      const close = handle.close.bind(handle);
      vi.spyOn(handle, "close").mockImplementation(async () => {
        closeCalls += 1;
        if (closeCalls === 1) throw closeFailure;
        await close();
      });
      return handle;
    });

    const result = await exportWebScripts(input, resources);
    if (result.ok) throw new Error("Expected invalid capture failure");
    expect(projectAnalysisError(result.error)).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [{ path: ["capture_path"], reason: "invalid_format" }],
      },
    });
    expect(result.error.cause).toBeInstanceOf(AggregateError);
    const cause = result.error.cause;
    if (!(cause instanceof AggregateError))
      throw new Error("Expected close diagnostic in the cause chain");
    expect(cause.errors.map((error) => String(error))).toContain(
      closeFailure.toString(),
    );
    expect(closeCalls).toBe(2);
    await resources.close();
  });

  it("makes scope close wait for an admitted capture read", async () => {
    const { input, resources } = await setup();
    let notifyOpen!: () => void;
    let releaseOpen!: () => void;
    const opened = new Promise<void>((resolve) => {
      notifyOpen = resolve;
    });
    const openGate = new Promise<void>((resolve) => {
      releaseOpen = resolve;
    });
    openMock.mockImplementation(async (...args) => {
      const handle = await actualFs.open(...args);
      if (String(args[0]) === input.capture_path) {
        notifyOpen();
        await openGate;
      }
      return handle;
    });

    const exporting = exportWebScripts(input, resources);
    try {
      await opened;
      let closeFinished = false;
      const closing = resources.close().then(() => {
        closeFinished = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closeFinished).toBe(false);

      releaseOpen();
      await closing;
      const result = await exporting;
      if (result.ok)
        throw new Error("Expected the closed scope to refuse publication");
      expect(result.error.userMessage).toContain("resource scope is closed");
      await expect(access(input.output_directory)).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      releaseOpen();
      await resources.close().catch(() => undefined);
    }
  });
});
