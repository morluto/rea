import { expect, test } from "vitest";

import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";

test("retains each script's context when a page reuses a context ID", async () => {
  const oldOrigin = "http://127.0.0.1:8080";
  const newOrigin = "http://localhost:8080";
  const scriptUrl = `${oldOrigin}/shared.js`;
  const script = {
    method: "Debugger.scriptParsed",
    params: {
      scriptId: "3",
      url: scriptUrl,
      executionContextId: 1,
      hash: "same-source",
      length: 24,
      isModule: false,
    },
  };
  const fake = await startFakeV8Inspector({
    targetUrl: `${oldOrigin}/page`,
    targetType: "page",
    runtimeProduct: "Electron/fixture",
    runtimeEvents: [
      {
        method: "Runtime.executionContextCreated",
        params: {
          context: { id: 1, uniqueId: "old", origin: oldOrigin, name: "" },
        },
      },
    ],
    scriptEvents: [
      script,
      { method: "Runtime.executionContextsCleared", params: {} },
      {
        method: "Runtime.executionContextCreated",
        params: {
          context: { id: 1, uniqueId: "new", origin: newOrigin, name: "" },
        },
      },
      script,
    ],
  });
  const provider = new V8InspectorProvider();
  try {
    const result = await provider.observe({
      inspector_endpoint: fake.endpoint,
      target_id: fake.targetId,
      runtime_kind: "electron-renderer",
      observation_ms: 0,
    });
    if (!result.ok) throw result.error;
    expect(result.value.scripts.observed_total).toBe(2);
    expect(result.value.scripts.items).toHaveLength(2);
    const scriptsByContext = new Map(
      result.value.scripts.items.map((item) => [
        item.execution_context_key,
        item,
      ]),
    );
    expect(scriptsByContext.size).toBe(2);
    expect(result.value.execution_contexts).toHaveLength(2);
    for (const [origin, state] of [
      [oldOrigin, "cleared"],
      [newOrigin, "created"],
    ] as const) {
      const context = result.value.execution_contexts.find(
        (item) => item.origin === origin,
      );
      expect(context).toMatchObject({ origin, state });
      expect(scriptsByContext.has(context?.context_key ?? null)).toBe(true);
    }
  } finally {
    await provider.close();
    await fake.close();
  }
});

test("retains a script's reported context ID when its context was not observed", async () => {
  const fake = await startFakeV8Inspector({
    targetUrl: "http://127.0.0.1:8080/page",
    targetType: "page",
    runtimeProduct: "Electron/fixture",
    runtimeEvents: [],
    scriptEvents: [
      {
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "3",
          url: "http://127.0.0.1:8080/shared.js",
          executionContextId: 17,
          hash: "source",
        },
      },
    ],
  });
  const provider = new V8InspectorProvider();
  try {
    const result = await provider.observe({
      inspector_endpoint: fake.endpoint,
      target_id: fake.targetId,
      runtime_kind: "electron-renderer",
      observation_ms: 0,
    });
    if (!result.ok) throw result.error;
    expect(result.value.scripts.items).toEqual([
      expect.objectContaining({
        execution_context_id: 17,
        execution_context_key: null,
      }),
    ]);
    expect(result.value.execution_contexts).toEqual([]);
  } finally {
    await provider.close();
    await fake.close();
  }
});

test("does not attribute a script to a superseded context when replacement metadata exceeds the budget", async () => {
  const fake = await startFakeV8Inspector({
    targetUrl: "http://127.0.0.1:8080/page",
    targetType: "page",
    runtimeProduct: "Electron/fixture",
    runtimeEvents: [
      {
        method: "Runtime.executionContextCreated",
        params: { context: { id: 1, origin: "http://old.test", name: "" } },
      },
    ],
    scriptEvents: [
      {
        method: "Runtime.executionContextCreated",
        params: {
          context: { id: 1, origin: "x".repeat(4 * 1024 * 1024), name: "" },
        },
      },
      {
        method: "Debugger.scriptParsed",
        params: {
          scriptId: "3",
          url: "http://127.0.0.1:8080/shared.js",
          executionContextId: 1,
          hash: "source",
        },
      },
    ],
  });
  const provider = new V8InspectorProvider();
  try {
    const result = await provider.observe({
      inspector_endpoint: fake.endpoint,
      target_id: fake.targetId,
      runtime_kind: "electron-renderer",
      observation_ms: 0,
    });
    if (!result.ok) throw result.error;
    expect(result.value.capture).toMatchObject({
      truncated: true,
      events_dropped: 1,
    });
    expect(result.value.scripts.items).toEqual([
      expect.objectContaining({
        execution_context_id: 1,
        execution_context_key: null,
      }),
    ]);
  } finally {
    await provider.close();
    await fake.close();
  }
});
