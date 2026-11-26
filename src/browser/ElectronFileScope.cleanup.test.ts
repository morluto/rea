import { createServer } from "node:http";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterEach, expect, it, vi } from "vitest";
import { asarHeaderBytes } from "../../tests/fixtures/asarHeader.js";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";

const handleState = vi.hoisted(() => ({
  archive: undefined as string | undefined,
  failCloseCount: 0,
  closeController: undefined as AbortController | undefined,
  closeReason: undefined as unknown,
  readController: undefined as AbortController | undefined,
  readReason: undefined as unknown,
  statController: undefined as AbortController | undefined,
  statReason: undefined as unknown,
  readFailure: undefined as Error | undefined,
  events: [] as string[],
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      if (String(args[0]) !== handleState.archive) return handle;
      handleState.events.push("open");
      return new Proxy(handle, {
        get(target, property, receiver) {
          if (property === "stat" && handleState.statController !== undefined)
            return async () => {
              const result = await target.stat();
              handleState.statController?.abort(handleState.statReason);
              handleState.statController = undefined;
              return result;
            };
          if (property === "read" && handleState.readFailure !== undefined)
            return async () => {
              const failure = handleState.readFailure;
              handleState.readFailure = undefined;
              throw failure;
            };
          if (property === "read" && handleState.readController !== undefined)
            return async (...args: Parameters<typeof target.read>) => {
              const response = await target.read(...args);
              handleState.readController?.abort(handleState.readReason);
              handleState.readController = undefined;
              return response;
            };
          if (property === "close")
            return async () => {
              handleState.events.push("close");
              if (handleState.closeController !== undefined) {
                handleState.closeController.abort(handleState.closeReason);
                handleState.closeController = undefined;
              }
              if (handleState.failCloseCount > 0) {
                handleState.failCloseCount -= 1;
                throw new Error("controlled ASAR descriptor close failure");
              }
              return await target.close();
            };
          return Reflect.get(target, property, receiver) as unknown;
        },
      });
    },
  };
});

import { ArtifactReaderFailure } from "../resources/ArtifactReader.js";
import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { CdpElectronProvider } from "./CdpElectronProvider.js";
import { V8InspectorProvider } from "../inspector/V8InspectorProvider.js";
import { observeJavaScriptRuntime } from "../application/javascript/JavaScriptRuntimeObservationService.js";
import { startFakeV8Inspector } from "../../tests/fixtures/inspector/fakeV8Inspector.js";
import {
  authorizedElectronFile,
  mapElectronFileAuthorizationFailure,
  retryElectronFileCleanup,
} from "./ElectronFileScope.js";

let scopeRoot: string;

afterEach(async () => {
  await retryElectronFileCleanup();
  handleState.archive = undefined;
  handleState.failCloseCount = 0;
  handleState.closeController = undefined;
  handleState.closeReason = undefined;
  handleState.readController = undefined;
  handleState.readReason = undefined;
  handleState.statController = undefined;
  handleState.statReason = undefined;
  handleState.readFailure = undefined;
  handleState.events = [];
});

const asarPage = async (): Promise<string> => {
  const root = await createTestTempDirectory("rea-electron-file-scope-");
  scopeRoot = root;
  const archive = join(root, "app.asar");
  const header = asarHeaderBytes(
    '{"files":{"index.html":{"size":1,"offset":"0"}}}',
  );
  await writeFile(archive, Buffer.concat([header, Buffer.of(0)]));
  handleState.archive = archive;
  return pathToFileURL(join(archive, "index.html")).href;
};

it("retains Inspector Evidence and scopes pending ASAR cleanup to the owning provider", async () => {
  const scriptUrl = await asarPage();
  const inspector = await startFakeV8Inspector({
    targetUrl: "https://example.test/entry.js",
    scriptUrls: [scriptUrl],
  });
  const provider = new V8InspectorProvider();
  const input = {
    inspector_endpoint: inspector.endpoint,
    target_id: inspector.targetId,
    observation_ms: 0,
  };
  try {
    handleState.failCloseCount = 1;
    const result = await observeJavaScriptRuntime(provider, input);
    if (result.ok) throw new Error("Expected descriptor close failure");
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(result.error.partialObservation).toMatchObject({
      normalized_result: {
        scripts: {
          observed_total: 1,
          items: [
            { location: { kind: "unresolved", reported_url: scriptUrl } },
          ],
        },
        execution_contexts: [{ name: "node[fixture]" }],
      },
    });
    const unrelated = new V8InspectorProvider();
    try {
      const listed = await unrelated.listTargets({
        inspector_endpoint: input.inspector_endpoint,
      });
      expect(listed).toMatchObject({
        ok: true,
        value: { targets: [{ target_id: inspector.targetId }] },
      });
    } finally {
      await unrelated.close();
    }
    expect(result.error.cleanupIncomplete).toBe(true);
    expect(handleState.events).toEqual(["open", "close"]);

    await provider.close();
    expect(result.error.cleanupIncomplete).toBe(false);
    expect(handleState.events).toEqual(["open", "close", "close"]);
  } finally {
    handleState.failCloseCount = 0;
    await provider.close();
    await inspector.close();
  }
});

it("retains a failed ASAR close through denial and retries before reopening", async () => {
  const location = await asarPage();
  const missing = pathToFileURL(
    join(dirname(fileURLToPath(location)), "missing.js"),
  ).href;
  handleState.failCloseCount = 1;

  let failure: unknown;
  try {
    await authorizedElectronFile(missing, undefined, "list_electron_targets");
  } catch (cause: unknown) {
    failure = cause;
  }

  if (!(failure instanceof ArtifactReaderFailure))
    throw new Error("Expected an ASAR descriptor cleanup failure");
  expect(failure.cleanup?.resources).toEqual([handleState.archive]);
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "list_electron_targets",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).toBeUndefined();

  await expect(
    authorizedElectronFile(missing, undefined, "list_electron_targets"),
  ).resolves.toBeUndefined();
  expect(handleState.events).toEqual([
    "open",
    "close",
    "close",
    "open",
    "close",
  ]);
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it.each([
  ["close", new Error("cancel during ASAR close")],
  ["read", { source: "caller", token: 17 }],
  ["stat", { source: "caller", stage: "descriptor-stat" }],
] as const)(
  "preserves cancellation during ASAR %s over a failed close and retries the descriptor",
  async (stage, reason) => {
    const location = await asarPage();
    const controller = new AbortController();
    handleState[`${stage}Controller`] = controller;
    handleState[`${stage}Reason`] = reason;
    handleState.failCloseCount = 1;

    const failure: unknown = await authorizedElectronFile(
      location,
      controller.signal,
    ).catch((cause: unknown) => cause);
    expect(failure).toBeInstanceOf(ArtifactReaderFailure);
    const mapped = mapElectronFileAuthorizationFailure(
      failure,
      "rea-cdp-electron",
      "inspect_electron_page",
    );
    expect(mapped?.cleanupIncomplete).toBe(true);
    expect(mapped?.cleanupPrimary).toBeInstanceOf(AnalysisCancelledError);
    expect(mapped?.cleanupPrimary?.cause).toBe(reason);

    await expect(authorizedElectronFile(location)).resolves.toBe(
      fileURLToPath(location),
    );
    expect(handleState.events).toEqual([
      "open",
      "close",
      "close",
      "open",
      "close",
    ]);
    expect(mapped?.cleanupIncomplete).toBe(false);
  },
);

it("keeps an earlier read failure primary over a later abort and close failure", async () => {
  const location = await asarPage();
  const controller = new AbortController();
  const reason = new Error("late cancellation after read failure");
  const readFailure = new Error("controlled ASAR header read failure");
  handleState.closeController = controller;
  handleState.closeReason = reason;
  handleState.failCloseCount = 1;
  handleState.readFailure = readFailure;

  let failure: unknown;
  try {
    await authorizedElectronFile(location, controller.signal);
  } catch (cause: unknown) {
    failure = cause;
  }
  const mapped = mapElectronFileAuthorizationFailure(
    failure,
    "rea-cdp-electron",
    "inspect_electron_page",
  );
  expect(mapped?.cleanupIncomplete).toBe(true);
  expect(mapped?.cleanupPrimary).not.toBeInstanceOf(AnalysisCancelledError);
  expect(mapped?.cleanupPrimary?.cause).toBe(readFailure);

  await expect(authorizedElectronFile(location)).resolves.toBe(
    fileURLToPath(location),
  );
  expect(mapped?.cleanupIncomplete).toBe(false);
});

it("retries a failed ASAR descriptor lease during provider shutdown", async () => {
  const location = await asarPage();
  handleState.failCloseCount = 1;
  await expect(authorizedElectronFile(location)).rejects.toBeInstanceOf(
    ArtifactReaderFailure,
  );

  await new CdpElectronProvider().close();

  expect(handleState.events).toEqual(["open", "close", "close"]);
});

it.each(["completed", "read-failed", "cancelled"] as const)(
  "retains the completed listing prefix after ASAR finalization: %s",
  async (mode) => {
    const archiveUrl = await asarPage();
    const page = join(scopeRoot, "first.html");
    await writeFile(page, "first");
    const controller = new AbortController();
    handleState.failCloseCount = 1;
    if (mode === "read-failed")
      handleState.readFailure = new Error("controlled ASAR read denial");
    if (mode === "cancelled") {
      handleState.closeController = controller;
      handleState.closeReason = { request: "ASAR descriptor close" };
    }
    let endpoint = "";
    const server = createServer((request, response) => {
      response.setHeader("Content-Type", "application/json");
      response.end(
        JSON.stringify(
          request.url === "/json/version"
            ? {
                Browser: "Electron/fixture",
                "Protocol-Version": "1.3",
                "WebKit-Version": "revision",
                "User-Agent": "fixture",
                "V8-Version": "V8",
                webSocketDebuggerUrl:
                  endpoint.replace("http:", "ws:") +
                  "/devtools/browser/fixture",
              }
            : [pathToFileURL(page).href, archiveUrl].map((url, index) => ({
                id: `page-${index}`,
                type: "page",
                title: `page ${index}`,
                url,
                attached: false,
                webSocketDebuggerUrl:
                  endpoint.replace("http:", "ws:") +
                  `/devtools/page/page-${index}`,
              })),
        ),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Expected discovery port");
    endpoint = `http://127.0.0.1:${address.port}`;
    const provider = new CdpElectronProvider();
    try {
      const result = await provider.listTargets(
        { cdp_endpoint: endpoint },
        { signal: controller.signal },
      );
      if (result.ok) throw new Error("Expected ASAR finalization failure");
      const origin = result.error.cleanupPrimary ?? result.error;
      expect(origin.diagnostics).toMatchObject({
        completed_prefix: {
          examined_targets: 1,
          allowed_targets: [{ target_id: "page-0", file_path: page }],
          coverage: expect.stringContaining("remaining targets are unknown"),
        },
      });
      expect(JSON.stringify(projectAnalysisError(result.error))).toContain(
        "completed_prefix",
      );
      expect(result.error.cleanupIncomplete).toBe(true);
      expect(handleState.events).toEqual(["open", "close"]);
      await provider.close();
      expect(result.error.cleanupIncomplete).toBe(false);
      expect(handleState.events).toEqual(["open", "close", "close"]);
      expect(origin.diagnostics).toHaveProperty("completed_prefix");
    } finally {
      handleState.failCloseCount = 0;
      await provider.close();
      await new Promise<void>((resolve, reject) =>
        server.close((cause) =>
          cause === undefined ? resolve() : reject(cause),
        ),
      );
    }
  },
);
