import { expect, it } from "vitest";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { finalizeInspectorCapture } from "./V8InspectorCaptureProjection.js";
import type { CaptureState } from "./V8InspectorProvider.js";

const target = {
  id: "target-1",
  type: "node",
  url: "file:///tmp/target.js",
  attached: false,
  webSocketUrl: "ws://127.0.0.1:9222/target-1",
  location: { kind: "file" as const, file_path: "/tmp/target.js" },
};
const stateFor = (scripts: CaptureState["scripts"]): CaptureState => ({
  scripts,
  contexts: new Map(),
  latestContexts: new Map(),
  eventsObserved: scripts.length,
  eventsRetained: scripts.length,
  eventsDropped: 0,
  metadataBytes: 0,
  scriptsObserved: scripts.length,
  invalidScripts: 0,
  parseFailedScripts: 0,
  invalidContexts: 0,
  truncated: false,
  truncationReasons: new Set(),
});
const finalize = (
  state: CaptureState,
  authorizeLocation?: Parameters<
    typeof finalizeInspectorCapture
  >[0]["authorizeLocation"],
) =>
  finalizeInspectorCapture({
    input: {
      inspector_endpoint: "http://127.0.0.1:9222",
      target_id: target.id,
      observation_ms: 100,
    },
    runtime: {
      product: "Node.js/v24.18.0",
      protocol_version: "1.3",
      v8_version: null,
    },
    target,
    state,
    ...(authorizeLocation === undefined ? {} : { authorizeLocation }),
  });

it("authorizes each unique script location through a bounded worker pool", async () => {
  const drafts = Array.from({ length: 200 }, (_, index) => ({
    rawUrl: `https://example.test/script-${String(index)}.js`,
    executionContextKey: "1",
    executionContextId: 1,
    cdpHash: `hash-${String(index)}`,
    length: 7,
    isModule: false,
  }));
  const state = stateFor([...drafts, ...drafts.slice(0, 1)]);
  const requestedUrls: string[] = [];
  let active = 0;
  let maximumActive = 0;
  await finalize(state, async (rawUrl) => {
    requestedUrls.push(rawUrl);
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise<void>((resolve) => setImmediate(resolve));
    active -= 1;
    return {
      allowed: true,
      location: {
        kind: "url",
        origin: "https://example.test",
        sanitized_url: rawUrl,
      },
    };
  });

  expect(maximumActive).toBeGreaterThan(1);
  expect(maximumActive).toBeLessThan(drafts.length);
  expect(requestedUrls.sort()).toEqual(
    drafts.map(({ rawUrl }) => rawUrl).sort(),
  );
  expect(active).toBe(0);
});

it("retains unique script facts and accounts for unresolved locations in partial captures", async () => {
  const file = {
    rawUrl: "file:///slow-or-unavailable.js?token=retained",
    executionContextKey: "1",
    executionContextId: 1,
    cdpHash: "observed",
    length: 7,
    isModule: false,
  };
  const state = stateFor([
    file,
    { ...file },
    {
      rawUrl: "https://example.test/script.js?caller-value=kept",
      executionContextKey: "1",
      executionContextId: 1,
      cdpHash: "remote",
      length: 12,
      isModule: true,
    },
    {
      rawUrl: "",
      executionContextKey: "1",
      executionContextId: 1,
      cdpHash: "anonymous",
      length: 0,
      isModule: false,
    },
  ]);
  state.eventsObserved += 1;
  state.eventsRetained += 1;
  state.contexts.set("1", {
    contextKey: "1",
    executionContextId: 1,
    state: "created",
    name: "main",
    origin: "file:///slow-or-unavailable.js?token=retained",
  });
  const result = await finalizeInspectorCapture({
    input: {
      inspector_endpoint: "http://127.0.0.1:9222",
      target_id: target.id,
      observation_ms: 100,
    },
    runtime: {
      product: "Node.js/v24.18.0",
      protocol_version: "1.3",
      v8_version: null,
    },
    target,
    state,
    locationMode: "reported",
    authorizeLocation: async () => {
      throw new Error(
        "Partial captures must not attempt location authorization",
      );
    },
  });

  expect(result.capture.events_observed).toBe(5);
  expect(result.capture.events_retained).toBe(5);
  expect(result.scripts.items).toHaveLength(3);
  expect(
    result.scripts.items.find(({ cdp_hash }) => cdp_hash === "observed"),
  ).toMatchObject({
    location: {
      kind: "unresolved",
      reported_url: "file:///slow-or-unavailable.js?token=retained",
      reason: "location-authorization-not-attempted",
    },
    length: 7,
  });
  expect(
    result.scripts.items.find(({ cdp_hash }) => cdp_hash === "remote"),
  ).toMatchObject({
    location: {
      kind: "url",
      origin: "https://example.test",
      sanitized_url: "https://example.test/script.js?caller-value=kept",
    },
    length: 12,
    is_module: true,
  });
  expect(
    result.scripts.items.find(({ cdp_hash }) => cdp_hash === "anonymous"),
  ).toMatchObject({
    location: {
      kind: "unresolved",
      reported_url: "",
      reason: "location-authorization-not-attempted",
    },
    length: 0,
  });
  expect(result.scripts.observed_total).toBe(4);
  expect(result.execution_contexts).toEqual([
    {
      context_key: "1",
      execution_context_id: 1,
      state: "created",
      name: "main",
      origin: "file:///slow-or-unavailable.js?token=retained",
    },
  ]);
  expect(result.unknowns).toContainEqual(
    expect.stringMatching(
      /2 observed script locations.*unverified.*raw URLs.*metadata.*retained/iu,
    ),
  );
});

it("waits for active authorization workers to settle before returning a failure", async () => {
  const scripts = Array.from({ length: 12 }, (_, index) => ({
    rawUrl: `file:///fixture/failure-${String(index)}.js`,
    executionContextKey: null,
    executionContextId: null,
    cdpHash: null,
    length: 0,
    isModule: false,
  }));
  const startedUrls: string[] = [];
  const pending = new Map<
    string,
    { readonly resolve: () => void; readonly reject: (error: Error) => void }
  >();
  const failure = new Error("authorization failed");
  let failureInjected = false;

  const finalization = finalize(stateFor(scripts), async (rawUrl) => {
    startedUrls.push(rawUrl);
    if (failureInjected)
      return { allowed: true, location: { kind: "file", file_path: rawUrl } };
    return new Promise<{
      readonly allowed: true;
      readonly location: { readonly kind: "file"; readonly file_path: string };
    }>((resolve, reject) => {
      pending.set(rawUrl, {
        resolve: () =>
          resolve({
            allowed: true,
            location: { kind: "file", file_path: rawUrl },
          }),
        reject,
      });
    });
  });
  const initialStarted = new Set(startedUrls);
  expect(initialStarted.size).toBeGreaterThan(1);
  const failingUrl = startedUrls[0];
  if (failingUrl === undefined)
    throw new Error("Expected at least one active authorization");
  const settled = finalization.then(
    () => true,
    () => true,
  );
  failureInjected = true;
  pending.get(failingUrl)?.reject(failure);
  const returnedBeforePeersFinished = await Promise.race([
    settled,
    new Promise<boolean>((resolve) => setImmediate(() => resolve(false))),
  ]);
  for (const [rawUrl, request] of pending)
    if (rawUrl !== failingUrl) request.resolve();

  await expect(finalization).rejects.toBe(failure);
  expect(returnedBeforePeersFinished).toBe(false);
  expect(startedUrls).toEqual([...initialStarted]);
});

it("stops finalization when cancellation arrives during location authorization", async () => {
  const controller = new AbortController();
  let authorizationStarted = false;
  const state = stateFor([
    {
      rawUrl: "https://example.test/script.js",
      executionContextKey: null,
      executionContextId: null,
      cdpHash: null,
      length: 0,
      isModule: false,
    },
  ]);

  const finalization = finalizeInspectorCapture({
    input: {
      inspector_endpoint: "http://127.0.0.1:9222",
      target_id: target.id,
      observation_ms: 100,
    },
    runtime: {
      product: "Node.js/v24.18.0",
      protocol_version: "1.3",
      v8_version: null,
    },
    target,
    state,
    signal: controller.signal,
    authorizeLocation: async () => {
      authorizationStarted = true;
      controller.abort();
      return {
        allowed: true,
        location: {
          kind: "url",
          origin: "https://example.test",
          sanitized_url: "https://example.test/script.js",
        },
      };
    },
  });

  await expect(finalization).rejects.toBeInstanceOf(AnalysisCancelledError);
  expect(authorizationStarted).toBe(true);
});
