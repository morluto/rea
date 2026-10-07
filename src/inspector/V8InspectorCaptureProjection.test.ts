import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterAll, beforeAll, expect, it } from "vitest";

import { authorizeRuntimeLocation } from "./JavaScriptRuntimeScope.js";
import { finalizeInspectorCapture } from "./V8InspectorCaptureProjection.js";
import type { CaptureState } from "./V8InspectorProvider.js";

let root: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "rea-inspector-projection-"));
});
afterAll(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true });
});

it("authorizes distinct Inspector locations and preserves stable deduplication", async () => {
  const firstPath = join(root, "first.js");
  const secondPath = join(root, "second.js");
  await Promise.all([
    writeFile(firstPath, "void 0;\n"),
    writeFile(secondPath, "void 1;\n"),
  ]);
  const firstUrl = pathToFileURL(firstPath).href;
  const secondUrl = pathToFileURL(secondPath).href;
  const state: CaptureState = {
    scripts: [
      {
        rawUrl: firstUrl,
        executionContextKey: "1",
        cdpHash: "first",
        length: 7,
        isModule: false,
      },
      {
        rawUrl: firstUrl,
        executionContextKey: "1",
        cdpHash: "first",
        length: 7,
        isModule: false,
      },
      {
        rawUrl: secondUrl,
        executionContextKey: "1",
        cdpHash: "second",
        length: 7,
        isModule: false,
      },
      {
        rawUrl: "ftp://example.test/unapproved.js",
        executionContextKey: null,
        cdpHash: null,
        length: 0,
        isModule: false,
      },
    ],
    contexts: new Map(),
    eventsObserved: 4,
    eventsRetained: 4,
    eventsDropped: 0,
    metadataBytes: 0,
    scriptsObserved: 4,
    invalidScripts: 0,
    truncated: false,
    truncationReasons: new Set(),
  };
  const result = await finalizeInspectorCapture({
    input: {
      inspector_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
      observation_ms: 100,
    },
    runtime: {
      product: "Node.js/v24.18.0",
      protocol_version: "1.3",
      v8_version: null,
    },
    target: {
      id: "target-1",
      type: "node",
      url: "file:///tmp/target.js",
      attached: false,
      webSocketUrl: "ws://127.0.0.1:9222/target-1",
      location: { kind: "file", file_path: "/tmp/target.js" },
    },
    state,
  });

  expect(result.scripts.items.map(({ location }) => location)).toEqual(
    expect.arrayContaining([
      { kind: "file", file_path: await realpath(firstPath) },
      { kind: "file", file_path: await realpath(secondPath) },
    ]),
  );
  expect(result.scripts.items).toHaveLength(2);
  expect(result.scripts.excluded).toEqual({
    unsupported_location: 1,
    invalid_protocol_value: 0,
  });
});

it("authorizes every unique script location through a bounded worker pool", async () => {
  const drafts = Array.from({ length: 200 }, (_, index) => ({
    rawUrl: `file:///fixture/script-${String(index)}.js`,
    executionContextKey: "1",
    cdpHash: `hash-${String(index)}`,
    length: 7,
    isModule: false,
  }));
  const state: CaptureState = {
    scripts: [
      ...drafts,
      ...drafts.slice(0, 1),
      {
        rawUrl: "ftp://example.test/unapproved.js",
        executionContextKey: null,
        cdpHash: null,
        length: 0,
        isModule: false,
      },
    ],
    contexts: new Map(),
    eventsObserved: 202,
    eventsRetained: 202,
    eventsDropped: 0,
    metadataBytes: 0,
    scriptsObserved: 202,
    invalidScripts: 0,
    truncated: false,
    truncationReasons: new Set(),
  };
  const activeUrls = new Set<string>();
  const authorizedUrls = new Set<string>();
  let maximumActive = 0;
  const result = await finalizeInspectorCapture({
    input: {
      inspector_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
      observation_ms: 100,
    },
    runtime: {
      product: "Node.js/v24.18.0",
      protocol_version: "1.3",
      v8_version: null,
    },
    target: {
      id: "target-1",
      type: "node",
      url: "file:///tmp/target.js",
      attached: false,
      webSocketUrl: "ws://127.0.0.1:9222/target-1",
      location: { kind: "file", file_path: "/tmp/target.js" },
    },
    state,
    authorizeLocation: async (rawUrl) => {
      activeUrls.add(rawUrl);
      authorizedUrls.add(rawUrl);
      maximumActive = Math.max(maximumActive, activeUrls.size);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeUrls.delete(rawUrl);
      return rawUrl.startsWith("ftp:")
        ? { allowed: false, reason: "unsupported_url" }
        : {
            allowed: true,
            location: { kind: "file", file_path: rawUrl },
          };
    },
  });

  expect(maximumActive).toBeGreaterThan(1);
  expect(maximumActive).toBeLessThan(authorizedUrls.size);
  expect(authorizedUrls.size).toBe(201);
  expect(activeUrls.size).toBe(0);
  expect(result.scripts.items).toHaveLength(200);
  expect(result.scripts.observed_total).toBe(202);
  expect(result.scripts.excluded).toEqual({
    unsupported_location: 1,
    invalid_protocol_value: 0,
  });
});

it("waits for active authorization workers to settle before returning a failure", async () => {
  const scripts = Array.from({ length: 12 }, (_, index) => ({
    rawUrl: `file:///fixture/failure-${String(index)}.js`,
    executionContextKey: null,
    cdpHash: null,
    length: 0,
    isModule: false,
  }));
  const state: CaptureState = {
    scripts,
    contexts: new Map(),
    eventsObserved: scripts.length,
    eventsRetained: scripts.length,
    eventsDropped: 0,
    metadataBytes: 0,
    scriptsObserved: scripts.length,
    invalidScripts: 0,
    truncated: false,
    truncationReasons: new Set(),
  };
  const startedUrls: string[] = [];
  const pendingAuthorizations = new Map<
    string,
    { readonly resolve: () => void; readonly reject: (error: Error) => void }
  >();
  const failure = new Error("authorization failed");
  let active = 0;
  let maximumActive = 0;
  let failureInjected = false;

  const finalization = finalizeInspectorCapture({
    input: {
      inspector_endpoint: "http://127.0.0.1:9222",
      target_id: "target-1",
      observation_ms: 100,
    },
    runtime: {
      product: "Node.js/v24.18.0",
      protocol_version: "1.3",
      v8_version: null,
    },
    target: {
      id: "target-1",
      type: "node",
      url: "file:///tmp/target.js",
      attached: false,
      webSocketUrl: "ws://127.0.0.1:9222/target-1",
      location: { kind: "file", file_path: "/tmp/target.js" },
    },
    state,
    authorizeLocation: async (rawUrl) => {
      startedUrls.push(rawUrl);
      if (failureInjected)
        return { allowed: true, location: { kind: "file", file_path: rawUrl } };
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      return new Promise<Awaited<ReturnType<typeof authorizeRuntimeLocation>>>(
        (resolve, reject) => {
          pendingAuthorizations.set(rawUrl, {
            resolve: () =>
              resolve({
                allowed: true,
                location: { kind: "file", file_path: rawUrl },
              }),
            reject,
          });
        },
      ).finally(() => {
        active -= 1;
      });
    },
  });
  const initialStarted = new Set(startedUrls);
  expect(initialStarted.size).toBeGreaterThan(1);
  expect(maximumActive).toBe(initialStarted.size);
  const failingUrl = startedUrls[0];
  if (failingUrl === undefined)
    throw new Error("Expected at least one active authorization");
  failureInjected = true;
  pendingAuthorizations.get(failingUrl)?.reject(failure);
  await Promise.resolve();
  expect(new Set(startedUrls)).toEqual(initialStarted);
  for (const [rawUrl, pending] of pendingAuthorizations)
    if (rawUrl !== failingUrl) pending.resolve();
  await expect(finalization).rejects.toBe(failure);
  expect(new Set(startedUrls)).toEqual(initialStarted);
  expect(active).toBe(0);
});
