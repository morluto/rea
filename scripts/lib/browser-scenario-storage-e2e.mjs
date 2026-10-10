import assert from "node:assert/strict";
import { createServer } from "node:http";
import { chromium } from "playwright-core";

import { browserScenarioSchema } from "../../dist/domain/browserScenario.js";
import { createBrowserScenarioProvider } from "../../dist/composition/browserScenario.js";
import {
  runScenarioCli,
  scenarioProfiles,
} from "./browser-scenario-verifier.mjs";

const assertExternalCleanup = async (browser, origin) => {
  if (browser === undefined) return;
  const connection = await chromium.connectOverCDP(browser.cdp_endpoint);
  try {
    let selected;
    for (const context of connection.contexts())
      for (const page of context.pages()) {
        const cdp = await context.newCDPSession(page);
        try {
          const { targetInfo } = await cdp.send("Target.getTargetInfo");
          if (targetInfo.targetId === browser.target_id) selected = page;
        } finally {
          await cdp.detach();
        }
      }
    assert.ok(selected, "The externally owned target was closed");
    await selected.goto(origin);
    await selected.evaluate(() => {
      localStorage.setItem("state", "after-cleanup");
      sessionStorage.setItem("state", "after-cleanup");
    });
    await selected.reload();
    assert.deepEqual(
      await selected.evaluate(() => ({
        local: localStorage.getItem("state"),
        session: sessionStorage.getItem("state"),
      })),
      { local: "after-cleanup", session: "after-cleanup" },
    );
    await selected.evaluate(() => {
      localStorage.removeItem("state");
      sessionStorage.removeItem("state");
    });
    await selected.reload();
    assert.deepEqual(
      await selected.evaluate(() => ({
        local: localStorage.getItem("state"),
        session: sessionStorage.getItem("state"),
      })),
      { local: null, session: null },
    );
  } finally {
    await connection.close();
  }
};

/** Verify seeded state is available to the first script and remains application-owned. */
export async function verifyScenarioStorage(executable, browser) {
  const server = createServer((_request, response) => {
    response.setHeader("content-type", "text/html");
    response.end(`<!doctype html><html><body>
      <pre id="state"></pre><button id="update">Update</button>
      <button id="delete">Delete</button><button id="empty">Empty</button>
      <script>
      const refresh = () => document.querySelector('#state').textContent = JSON.stringify({
        local: localStorage.getItem('state'), session: sessionStorage.getItem('state'),
        localKeys: Object.keys(localStorage), sessionKeys: Object.keys(sessionStorage)
      });
      for (const action of ['update', 'delete', 'empty'])
        document.getElementById(action).onclick = () => {
          for (const storage of [localStorage, sessionStorage]) {
            if (action === 'delete') storage.removeItem('state');
            else storage.setItem('state', action === 'empty' ? '' : 'updated');
          }
          refresh();
        };
      refresh();
      </script></body></html>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const otherOrigin = `http://localhost:${port}`;
  const profilesBefore = await scenarioProfiles();
  const goto = (step_id, url) => ({
    step_id,
    action: "goto",
    destination: { url },
    wait_until: "load",
    timeout_ms: 5_000,
  });
  const click = (step_id) => ({
    step_id,
    action: "click",
    locator: { kind: "css", selector: `#${step_id}` },
    timeout_ms: 5_000,
  });
  try {
    const scenario = browserScenarioSchema.parse({
      browser: browser ?? { mode: "launch", executable_path: executable },
      start_url: { url: origin },
      storage: Object.fromEntries(
        ["local_storage", "session_storage"].map((kind) => [
          kind,
          [origin, otherOrigin].map((origin) => ({
            origin,
            entries: [
              { name: "state", value: { source: "literal", value: "initial" } },
            ],
          })),
        ]),
      ),
      actions: [
        click("update"),
        goto("same_origin", `${origin}/next`),
        click("delete"),
        goto("after_delete", `${origin}/deleted`),
        click("empty"),
        goto("after_empty", `${origin}/empty`),
        goto("late_origin", otherOrigin),
        goto("return_origin", origin),
        goto("return_late_origin", otherOrigin),
      ],
      capture: {
        after_each_step: ["dom", "storage"],
        at_end: ["dom", "storage"],
      },
    });
    const capture = (await runScenarioCli(scenario)).normalized_result;
    const expected = [
      "initial",
      "updated",
      "updated",
      null,
      null,
      "",
      "",
      "initial",
      "",
      "initial",
    ];
    assert.equal(capture.steps.length, expected.length);
    for (const [index, step] of capture.steps.entries()) {
      assert.equal(step.status, "completed");
      assert.equal(step.artifacts.dom.state, "captured");
      const match = /<pre id="state">([^<]+)<\/pre>/u.exec(
        step.artifacts.dom.value.text,
      );
      assert.ok(
        match,
        `Missing initial-script storage observation at ${step.step_id}`,
      );
      const observed = JSON.parse(match[1].replaceAll("&quot;", '"'));
      assert.deepEqual(
        observed,
        {
          local: expected[index],
          session: expected[index],
          localKeys: expected[index] === null ? [] : ["state"],
          sessionKeys: expected[index] === null ? [] : ["state"],
        },
        step.step_id,
      );
      assert.equal(step.artifacts.storage.state, "captured");
      for (const kind of ["local_storage", "session_storage"])
        assert.deepEqual(
          step.artifacts.storage.value[kind].map(({ name }) => name),
          observed[kind === "local_storage" ? "localKeys" : "sessionKeys"],
        );
    }
    assert.equal(
      capture.browser.cleanup,
      browser === undefined
        ? "terminated-owned-process"
        : "disconnected-external",
    );
    const profilesAfter = await scenarioProfiles();
    await assertExternalCleanup(browser, otherOrigin);
    assert.ok(
      [...profilesAfter].every((profile) => profilesBefore.has(profile)),
    );
    return {
      mocked: false,
      cli: true,
      first_script: true,
      changes_deletions_and_empty_values_preserved: true,
      late_origin: true,
      storage_keys_unpolluted: true,
      profile_cleanup: true,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}

/** Exercise live frames, simultaneous navigations, OOPIFs, and top-site partitions. */
export async function verifyScenarioStorageFrames(
  executable,
  browser,
  partitioned = false,
) {
  let port;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "text/html");
    if (request.url === "/concurrent") {
      response.end(`<!doctype html><pre id="counter"></pre><script>
        const observed = [];
        onmessage = event => {observed.push(event.data);document.getElementById('counter').textContent=JSON.stringify(observed);if(observed.length===4)document.body.dataset.ready='true';};
        for(let index=0;index<4;index++){const frame=document.createElement('iframe');frame.src='http://localhost:${port}/counter?index='+index;document.body.append(frame);}
      </script>`);
    } else if (request.url.startsWith("/counter?")) {
      response.end(`<!doctype html><script>
        const observed={local:Number(localStorage.getItem('counter')),session:Number(sessionStorage.getItem('counter'))};
        localStorage.setItem('counter',String(observed.local+1));sessionStorage.setItem('counter',String(observed.session+1));parent.postMessage(observed,'*');
      </script>`);
    } else if (request.url === "/frames") {
      response.end(`<!doctype html><html><body><pre id="frames"></pre><script>
        const observations = [];
        onmessage = event => {
          observations.push(event.data);
          document.getElementById('frames').textContent = JSON.stringify(observations);
          if (observations.length < 4) appendFrame();
          else document.body.dataset.ready = 'true';
        };
        function appendFrame() {
          const frame = document.createElement('iframe');
          frame.src = 'http://localhost:${port}/frame?index=' + observations.length;
          document.body.append(frame);
        }
        appendFrame();
      </script></body></html>`);
    } else if (request.url.startsWith("/frame?")) {
      response.end(`<!doctype html><script>
        const values = { local: localStorage.getItem('state'), session: sessionStorage.getItem('state') };
        const index = Number(new URL(location.href).searchParams.get('index'));
        for (const storage of [localStorage, sessionStorage]) {
          if (index === 0) storage.setItem('state', 'updated');
          else if (index === 1) storage.removeItem('state');
          else if (index === 2) storage.setItem('state', '');
        }
        parent.postMessage(values, '*');
      </script>`);
    } else {
      response.end(`<!doctype html><pre id="top"></pre><script>
        document.getElementById('top').textContent = JSON.stringify({local:localStorage.getItem('state'),session:sessionStorage.getItem('state')});
      </script>`);
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = server.address().port;
  const origin = `http://127.0.0.1:${port}`;
  const frameOrigin = `http://localhost:${port}`;
  try {
    const capture = (
      await runScenarioCli(
        browserScenarioSchema.parse({
          browser: browser ?? { mode: "launch", executable_path: executable },
          start_url: { url: `${origin}/frames` },
          storage: Object.fromEntries(
            ["local_storage", "session_storage"].map((kind) => [
              kind,
              [
                {
                  origin: frameOrigin,
                  entries: [
                    {
                      name: "state",
                      value: { source: "literal", value: "initial" },
                    },
                    {
                      name: "counter",
                      value: { source: "literal", value: "0" },
                    },
                  ],
                },
              ],
            ]),
          ),
          actions: [
            {
              step_id: "frames_ready",
              action: "wait_for",
              locator: { kind: "css", selector: 'body[data-ready="true"]' },
              state: "attached",
              timeout_ms: 5000,
            },
            {
              step_id: "top_partition",
              action: "goto",
              destination: { url: frameOrigin },
              wait_until: "load",
              timeout_ms: 5000,
            },
            {
              step_id: "return_frames",
              action: "goto",
              destination: { url: `${origin}/frames` },
              wait_until: "load",
              timeout_ms: 5000,
            },
            {
              step_id: "return_frames_ready",
              action: "wait_for",
              locator: { kind: "css", selector: 'body[data-ready="true"]' },
              state: "attached",
              timeout_ms: 5000,
            },
            {
              step_id: "concurrent",
              action: "goto",
              destination: { url: `${origin}/concurrent` },
              wait_until: "load",
              timeout_ms: 5000,
            },
            {
              step_id: "concurrent_ready",
              action: "wait_for",
              locator: { kind: "css", selector: 'body[data-ready="true"]' },
              state: "attached",
              timeout_ms: 5000,
            },
          ],
          capture: { after_each_step: ["dom"], at_end: ["dom"] },
        }),
      )
    ).normalized_result;
    const read = (stepId, element) => {
      const step = capture.steps.find((step) => step.step_id === stepId);
      assert.equal(step.status, "completed");
      assert.equal(step.artifacts.dom.state, "captured");
      const match = new RegExp(`<pre id="${element}">([^<]+)</pre>`, "u").exec(
        step.artifacts.dom.value.text,
      );
      assert.ok(match);
      return JSON.parse(match[1]);
    };
    assert.deepEqual(
      read("frames_ready", "frames"),
      ["initial", "updated", null, ""].map((value) => ({
        local: value,
        session: value,
      })),
    );
    assert.deepEqual(read("top_partition", "top"), {
      local: partitioned ? "initial" : "",
      session: partitioned ? "initial" : "",
    });
    assert.deepEqual(
      read("return_frames_ready", "frames"),
      ["", "updated", null, ""].map((value) => ({
        local: value,
        session: value,
      })),
    );
    assert.deepEqual(
      read("concurrent_ready", "counter").sort((a, b) => a.local - b.local),
      [0, 1, 2, 3].map((value) => ({ local: value, session: value })),
    );
    assert.equal(
      capture.browser.cleanup,
      browser === undefined
        ? "terminated-owned-process"
        : "disconnected-external",
    );
    await assertExternalCleanup(browser, frameOrigin);
    return {
      mocked: false,
      cli: true,
      oopif: true,
      concurrent_frames: true,
      first_script: true,
      partitioned,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

/** Cancellation is an API boundary: the CLI has no AbortSignal argument. */
export async function verifyScenarioStorageFailures(executable) {
  const cancellation = new AbortController();
  const server = createServer((request, response) => {
    if (request.url === "/failure") {
      response.destroy();
      return;
    }
    if (request.url === "/cancel") {
      cancellation.abort();
      return;
    }
    response.setHeader("content-type", "text/html");
    response.end(
      "<!doctype html><script>document.title=localStorage.getItem('state');</script>",
    );
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const scenario = browserScenarioSchema.parse({
      browser: { mode: "launch", executable_path: executable },
      start_url: { url: origin },
      storage: {
        local_storage: [
          {
            origin,
            entries: [
              { name: "state", value: { source: "literal", value: "initial" } },
            ],
          },
        ],
      },
      actions: [
        {
          step_id: "fail",
          action: "goto",
          destination: { url: `${origin}/failure` },
          wait_until: "load",
          timeout_ms: 2000,
        },
      ],
      capture: { after_each_step: ["dom"] },
    });
    const provider = createBrowserScenarioProvider(process.env);
    const failure = await provider.captureScenario(scenario);
    if (!failure.ok) throw failure.error;
    assert.equal(failure.value.steps.at(-1).status, "failed");
    assert.equal(failure.value.browser.cleanup, "terminated-owned-process");
    const cancelled = await provider.captureScenario(
      { ...scenario, start_url: { url: `${origin}/cancel`, query: [] } },
      { signal: cancellation.signal },
    );
    assert.equal(cancelled.ok, false);
    assert.equal(cancelled.error._tag, "AnalysisCancelledError");
    assert.equal(cancelled.error.cleanupIncomplete, false);
    assert.equal(
      cancelled.error.partialObservation.capture.browser.cleanup,
      "terminated-owned-process",
    );
    return {
      mocked: false,
      provider_boundary: true,
      failed_navigation_cleanup: true,
      cancelled_initial_navigation_cleanup: true,
    };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
