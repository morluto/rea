import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { CdpConnection } from "../../dist/browser/CdpConnection.js";
import { createBrowserScenarioProvider } from "../../dist/composition/browserScenario.js";
import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";
import { runScenarioCli } from "./browser-scenario-verifier.mjs";
import { requireMcpEvidenceResult } from "./mcp-verifier-results.mjs";

const expected = {
  timezone: "Pacific/Honolulu",
  locale: "fr-FR",
  dpr: 2,
  width: 900,
  height: 600,
};
const alternate = {
  timezone: "UTC",
  locale: "en-US",
  dpr: 1,
  width: 700,
  height: 500,
};
const expression = `JSON.stringify({
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  dpr: devicePixelRatio, width: innerWidth, height: innerHeight
})`;

const environmentScenario = ({ endpoint, targetId, origin, values, run }) =>
  browserScenarioSchema.parse({
    browser: { mode: "connect", cdp_endpoint: endpoint, target_id: targetId },
    start_url: {
      url: `${origin}/scenario-environment${run === undefined ? "" : `?run=${run}`}`,
    },
    environment: {
      locale: values.locale,
      timezone: values.timezone,
      viewport: {
        width: values.width,
        height: values.height,
        device_scale_factor: values.dpr,
      },
    },
    actions:
      run === undefined
        ? [
            {
              step_id: "refresh",
              action: "click",
              locator: { kind: "css", selector: "#refresh-environment" },
            },
          ]
        : [
            {
              step_id: `gate_${run}`,
              action: "wait_for",
              locator: { kind: "css", selector: `#release-${run}` },
              state: "attached",
              timeout_ms: 30_000,
            },
            {
              step_id: `refresh_${run}`,
              action: "click",
              locator: { kind: "css", selector: "#refresh-environment" },
            },
          ],
    capture: { after_each_step: ["dom"], at_end: ["dom"] },
  });

const assertCapture = (capture, values = expected) => {
  assert.equal(capture.browser.cleanup, "disconnected-external");
  for (const step of capture.steps) {
    assert.equal(step.artifacts.dom.state, "captured");
    const text = step.artifacts.dom.value.text;
    const observed = /<pre id="environment">([^<]+)<\/pre>/u.exec(text);
    assert.ok(observed, "DOM omitted the page's actual environment values");
    assert.deepEqual(JSON.parse(observed[1]), values);
  }
};

/** Verify actual attached-page emulation and restoration across scenario outcomes. */
export async function verifyScenarioEnvironment(endpoint, targetId, origin) {
  const targets = await (await fetch(`${endpoint}/json/list`)).json();
  const target = targets.find(({ id }) => id === targetId);
  assert.ok(target, "External fixture target is missing");
  const connection = await CdpConnection.connect(
    target.webSocketDebuggerUrl,
    "capture_browser_scenario",
  );
  const readEnvironment = async () => {
    const value = await connection.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
    });
    assert.equal(value.result.type, "string");
    return JSON.parse(value.result.value);
  };
  const baseline = await readEnvironment();
  const scenario = environmentScenario({
    endpoint,
    targetId,
    origin,
    values: expected,
  });
  const assertRestored = async () => {
    assert.deepEqual(await readEnvironment(), baseline);
    const remaining = await (await fetch(`${endpoint}/json/list`)).json();
    assert.ok(remaining.some(({ id }) => id === targetId));
  };
  try {
    assertCapture((await runScenarioCli(scenario)).normalized_result);
    await assertRestored();
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [fileURLToPath(new URL("../rea.mjs", import.meta.url)), "mcp"],
      env: process.env,
      stderr: "pipe",
    });
    const client = new Client({
      name: "browser-environment-e2e",
      version: "1",
    });
    try {
      await client.connect(transport);
      assertCapture(
        requireMcpEvidenceResult(
          await client.callTool({
            name: "capture_browser_scenario",
            arguments: scenario,
          }),
          "capture_browser_scenario",
        ),
      );
      await verifyConcurrentMcpCapture({
        client,
        connection,
        endpoint,
        targetId,
        origin,
        readEnvironment,
        assertRestored,
      });
    } finally {
      await client.close();
      await transport.close();
    }
    await assertRestored();
    const provider = createBrowserScenarioProvider(process.env);
    const initializationFailure = await provider.captureScenario({
      ...scenario,
      environment: { ...scenario.environment, timezone: "REA/Invalid" },
    });
    assert.equal(initializationFailure.ok, false);
    await assertRestored();
    const waiting = browserScenarioSchema.parse({
      ...scenario,
      actions: [
        {
          step_id: "missing",
          action: "wait_for",
          locator: { kind: "css", selector: "#missing-environment-element" },
          state: "visible",
          timeout_ms: 100,
        },
      ],
    });
    const actionFailure = await provider.captureScenario(waiting);
    assert.equal(actionFailure.ok, true);
    assertCapture(actionFailure.value);
    assert.equal(actionFailure.value.steps.at(-1).status, "failed");
    await assertRestored();
    await verifyCancelledEnvironment(
      provider,
      connection,
      waiting,
      readEnvironment,
    );
    await assertRestored();
    return {
      mocked: false,
      cli: true,
      stdio_mcp: true,
      observed: expected,
      restored: baseline,
      initialization_failure_cleanup: true,
      action_failure_cleanup: true,
      cancellation_cleanup: true,
      external_target_preserved: true,
    };
  } finally {
    await connection.close();
  }
}

const verifyConcurrentMcpCapture = async ({
  client,
  connection,
  endpoint,
  targetId,
  origin,
  readEnvironment,
  assertRestored,
}) => {
  const firstScenario = environmentScenario({
    endpoint,
    targetId,
    origin,
    values: expected,
    run: "A",
  });
  const secondScenario = environmentScenario({
    endpoint,
    targetId,
    origin,
    values: alternate,
    run: "B",
  });
  const firstCancellation = new AbortController();
  const secondCancellation = new AbortController();
  const cancellation = new AbortController();
  const pendingCalls = [];
  const callTool = (arguments_, signal) => {
    const pending = client.callTool(
      { name: "capture_browser_scenario", arguments: arguments_ },
      { signal, timeout: 60_000 },
    );
    void pending.catch(() => {});
    pendingCalls.push(pending);
    return pending;
  };

  try {
    const first = callTool(firstScenario, firstCancellation.signal);
    await waitForEnvironment(readEnvironment, connection, expected, "A");

    const second = callTool(secondScenario, secondCancellation.signal);
    await client.ping();
    assert.deepEqual(await readEnvironment(), expected);
    assert.equal(await readScenarioRun(connection), "A");

    const cancelled = callTool(
      environmentScenario({
        endpoint,
        targetId,
        origin,
        values: alternate,
        run: "C",
      }),
      cancellation.signal,
    );
    await client.ping();
    cancellation.abort(new Error("cancel queued browser scenario"));
    await assert.rejects(cancelled, /cancel queued browser scenario/u);
    assert.deepEqual(await readEnvironment(), expected);
    assert.equal(await readScenarioRun(connection), "A");

    await releaseScenario(connection);
    assertCapture(
      requireMcpEvidenceResult(await first, "capture_browser_scenario"),
      expected,
    );

    await waitForEnvironment(readEnvironment, connection, alternate, "B");
    await releaseScenario(connection);
    assertCapture(
      requireMcpEvidenceResult(await second, "capture_browser_scenario"),
      alternate,
    );
    await client.ping();
    await assertRestored();
  } finally {
    firstCancellation.abort();
    secondCancellation.abort();
    cancellation.abort();
    await releaseScenario(connection).catch(() => undefined);
    await Promise.allSettled(pendingCalls);
  }
};

const waitForEnvironment = async (
  readEnvironment,
  connection,
  expectedValues,
  run,
) => {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (
      JSON.stringify(await readEnvironment()) ===
        JSON.stringify(expectedValues) &&
      (await readScenarioRun(connection)) === run
    )
      return;
    await delay(25);
  }
  throw new Error(`Scenario ${run} never reached its page-controlled gate`);
};

const readScenarioRun = async (connection) => {
  const value = await connection.send("Runtime.evaluate", {
    expression: "document.body.dataset.run ?? null",
    returnByValue: true,
  });
  return value.result.value;
};

const releaseScenario = async (connection) => {
  await connection.send("Runtime.evaluate", {
    expression: "window.releaseScenario()",
    returnByValue: true,
  });
};

async function verifyCancelledEnvironment(
  provider,
  connection,
  scenario,
  readEnvironment,
) {
  const controller = new AbortController();
  const priorNavigation = await connection.send("Runtime.evaluate", {
    expression: "performance.timeOrigin",
    returnByValue: true,
  });
  const pending = provider.captureScenario(
    { ...scenario, actions: [{ ...scenario.actions[0], timeout_ms: 30_000 }] },
    { signal: controller.signal },
  );
  try {
    const deadline = Date.now() + 10_000;
    while (true) {
      const navigation = await connection.send("Runtime.evaluate", {
        expression: "performance.timeOrigin",
        returnByValue: true,
      });
      if (
        navigation.result.value !== priorNavigation.result.value &&
        JSON.stringify(await readEnvironment()) === JSON.stringify(expected)
      )
        break;
      assert.ok(Date.now() < deadline, "Scenario never applied emulation");
      await delay(25);
    }
    await delay(100);
  } finally {
    controller.abort();
  }
  const cancelled = await pending;
  assert.ok(
    !cancelled.ok ||
      cancelled.value.steps.some(({ status }) => status === "cancelled"),
    "Cancellation unexpectedly completed every action",
  );
}
