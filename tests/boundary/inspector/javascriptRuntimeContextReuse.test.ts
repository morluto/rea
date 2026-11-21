import { expect, test } from "vitest";

import { V8InspectorProvider } from "../../../src/inspector/V8InspectorProvider.js";
import { startFakeV8Inspector } from "../../fixtures/inspector/fakeV8Inspector.js";

test("attributes scripts to their own context lifetime across a clear and ID reuse", async () => {
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
  const beforeClear = `${oldOrigin}/before.js`;
  const afterClear = `${oldOrigin}/after.js`;
  const betweenContexts = `${oldOrigin}/between.js`;
  const unobservedContext = `${oldOrigin}/unobserved.js`;
  const fake = await startFakeV8Inspector({
    targetUrl: `${oldOrigin}/page`,
    targetType: "page",
    runtimeProduct: "Electron/fixture",
    runtimeEvents: [
      {
        method: "Runtime.executionContextCreated",
        params: {
          context: { id: 1, origin: oldOrigin, name: "old frame" },
        },
      },
    ],
    scriptEvents: [
      script,
      {
        ...script,
        params: { ...script.params, scriptId: "4", url: beforeClear },
      },
      { method: "Runtime.executionContextsCleared", params: {} },
      {
        ...script,
        params: { ...script.params, scriptId: "5", url: betweenContexts },
      },
      {
        method: "Runtime.executionContextCreated",
        params: {
          context: { id: 1, origin: newOrigin, name: "new frame" },
        },
      },
      script,
      {
        ...script,
        params: { ...script.params, scriptId: "6", url: afterClear },
      },
      {
        ...script,
        params: {
          ...script.params,
          scriptId: "7",
          url: unobservedContext,
          executionContextId: 17,
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
    const { execution_contexts: contexts, scripts } = result.value;
    expect(contexts).toHaveLength(2);
    const oldContext = contexts.find(({ origin }) => origin === oldOrigin);
    const newContext = contexts.find(({ origin }) => origin === newOrigin);
    expect(oldContext).toMatchObject({
      execution_context_id: 1,
      name: "old frame",
      state: "cleared",
    });
    expect(newContext).toMatchObject({
      execution_context_id: 1,
      name: "new frame",
      state: "created",
    });
    const oldKey = oldContext?.context_key;
    const newKey = newContext?.context_key;
    expect(oldKey).not.toBe(newKey);

    expect(scripts.observed_total).toBe(6);
    expect(scripts.items).toHaveLength(6);
    expect(scripts.items).toEqual(
      expect.arrayContaining(
        [
          [scriptUrl, 1, oldKey],
          [scriptUrl, 1, newKey],
          [beforeClear, 1, oldKey],
          [afterClear, 1, newKey],
          [betweenContexts, 1, null],
          [unobservedContext, 17, null],
        ].map(([url, id, key]) =>
          expect.objectContaining({
            location: expect.objectContaining({
              kind: "url",
              sanitized_url: url,
            }),
            execution_context_id: id,
            execution_context_key: key,
          }),
        ),
      ),
    );
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
