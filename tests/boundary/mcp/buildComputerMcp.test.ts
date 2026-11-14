import {
  chmod,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import type { Client } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import {
  buildComputerFakes as fakes,
  bundleFolder,
  callOk,
  connectBuildServer as connect,
  expectNoToken,
  startBuildComputer,
} from "../../fixtures/buildComputerMcp.js";
import {
  FAKE_FRAME_PNG,
  type FakeApp,
  type FakeComputer,
} from "../../fixtures/fakeAgentEnvComputer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { waitFor } from "../../support/testWait.js";

const images = (result: CallToolResult) =>
  result.content.filter((block) => block.type === "image");

const startFromBundle = async (client: Client, computer: FakeComputer) => {
  const started = await client.callTool({
    name: "start_build_computer",
    arguments: { source: { kind: "bundle", path: await bundleFolder() } },
  });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  expectNoToken(computer, started);
  return {
    started,
    value: toolContract("start_build_computer").outputSchema.parse(
      started.structuredContent,
    ),
  };
};

it("keeps a computer up, forwards actions with their images and tears it down on close", async () => {
  const { computer, runner } = await fakes({ notReadyPolls: 2 });
  const client = await connect(runner.environment);
  const { started, value } = await startFromBundle(client, computer);
  expect(value.sandbox_id).toBe("sbx-fake");
  expect(images(started)).toEqual([
    { type: "image", data: FAKE_FRAME_PNG, mimeType: "image/png" },
  ]);
  expect(await runner.notes("runs.jsonl")).toMatchObject([
    { tasks: ["smoke"], keep: true, emulate: false, sandbox: "local" },
  ]);
  // Readiness was polled with the token until it passed; /mcp needs none.
  expect(computer.unauthorized).toEqual([]);

  const act = (action: string, fields: Record<string, unknown> = {}) =>
    client.callTool({
      name: "act_on_build_computer",
      arguments: { computer_id: value.computer_id, action, ...fields },
    });
  const screenshot = await act("screenshot", {
    region: [0, 0, 500, 500],
    format: "jpeg",
    space: "norm",
  });
  expect(screenshot.isError).not.toBe(true);
  expect(images(screenshot)).toHaveLength(1);
  expect(screenshot.content).toContainEqual({
    type: "text",
    text: "computer_screenshot done",
  });
  const clicked = await act("click", { x: 640, y: 400, count: 2 });
  expect(images(clicked)).toEqual([]);
  expect(
    toolContract("act_on_build_computer").outputSchema.parse(
      clicked.structuredContent,
    ),
  ).toMatchObject({
    action: "click",
    action_index: 1,
    result: { applied: "yes" },
  });
  await act("key", { keys: ["ctrl+s"], screenshot: true });
  expect(computer.calls.slice(1)).toEqual([
    {
      name: "computer_screenshot",
      arguments: { region: [0, 0, 500, 500], format: "jpeg", space: "norm" },
    },
    { name: "computer_click", arguments: { x: 640, y: 400, count: 2 } },
    {
      name: "computer_key",
      arguments: { keys: ["Control", "s"], screenshot: true },
    },
  ]);

  computer.refuseNext(
    "computer_drag",
    "stale_frame: there is no frame yet: take a screenshot first",
  );
  const refused = await act("drag", {
    path: [
      [1, 1],
      [9, 9],
    ],
  });
  expectNoToken(computer, refused);
  expect(parseMcpToolError(refused).error.message).toContain(
    "stale_frame: there is no frame yet",
  );
  const misplaced = await act("type", { text: "hi", x: 3 });
  expect(parseMcpToolError(misplaced).error.code).toBe("invalid_request");
  expect(computer.calls.map(({ name }) => name).at(-1)).toBe("computer_drag");

  const closed = await client.callTool({
    name: "close_build_computer",
    arguments: { computer_id: value.computer_id },
  });
  expect(closed.structuredContent).toEqual({
    computer_id: value.computer_id,
    teardown: "agentenv",
  });
  expect(await runner.notes("teardowns.jsonl")).toHaveLength(1);
  const after = await act("screenshot");
  expect(parseMcpToolError(after).error.message).toContain(
    "start_build_computer",
  );
});

it("renders a build bundle from a request with REA's payload and starts it", async () => {
  const { computer, runner } = await fakes();
  const payload = join(runner.state, "rea-prod.tar.xz");
  await writeFile(payload, "a packed REA build");
  const client = await connect({
    ...runner.environment,
    REA_BUILD_COMPUTER_REA_ARCHIVE: payload,
  });
  const started = await client.callTool({
    name: "start_build_computer",
    arguments: {
      source: {
        kind: "request",
        desktop_entry: "org.xfce.mousepad",
        install: {
          kind: "archive",
          package: "mousepad",
          extra_packages: ["librsvg2-common"],
        },
      },
    },
  });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  expect(started.structuredContent).toMatchObject({
    environment: "mousepad",
    extra_packages: ["librsvg2-common"],
  });
  const env = join(runner.state, "bundle", "envs", "mousepad");
  expect(await readFile(join(env, "rea-payload.tar"), "utf8")).toBe(
    "a packed REA build",
  );
  const module = await readFile(join(env, "mousepad_app.py"), "utf8");
  expect(module).toContain('Launch(at="demand"');
  expect(module).toContain(
    'packages=Packages(apt=["mousepad", "librsvg2-common", "libgtk-3-bin", "dconf-cli"])',
  );
  const { computer_id: computerId } = toolContract(
    "start_build_computer",
  ).outputSchema.parse(started.structuredContent);
  await client.callTool({
    name: "close_build_computer",
    arguments: { computer_id: computerId },
  });
  expect(computer.calls.map(({ name }) => name)).toEqual([
    "computer_screenshot",
  ]);
});

it.each([
  ["glabels-3.0", "glabels"],
  ["com.github.xournalpp.xournalpp", "xournalpp"],
  ["mousepad", "mousepad"],
])(
  "names the environment of desktop entry %s %s",
  async (entry, environment) => {
    const { runner } = await fakes();
    const payload = join(runner.state, "rea-prod.tar.xz");
    await writeFile(payload, "a packed REA build");
    const client = await connect({
      ...runner.environment,
      REA_BUILD_COMPUTER_REA_ARCHIVE: payload,
    });

    const started = await callOk(client, "start_build_computer", {
      source: {
        kind: "request",
        desktop_entry: entry,
        install: { kind: "archive", package: environment },
      },
    });

    expect(started.structuredContent).toMatchObject({ environment });
    expect(await readdir(join(runner.state, "bundle", "envs"))).toEqual([
      environment,
    ]);
  },
);

it("names what a request needs when REA's payload is not configured", async () => {
  const { runner } = await fakes();
  const client = await connect(runner.environment);
  const refused = await client.callTool({
    name: "start_build_computer",
    arguments: {
      source: {
        kind: "request",
        desktop_entry: "mousepad",
        install: { kind: "archive", package: "mousepad" },
      },
    },
  });
  expect(JSON.stringify(parseMcpToolError(refused))).toContain(
    "REA_BUILD_COMPUTER_REA_ARCHIVE",
  );
  expect(await runner.notes("runs.jsonl")).toEqual([]);
});

it.each([
  [
    ["Java17"],
    {
      path: ["source", "install", "extra_packages", 0],
      reason: "invalid_format",
    },
  ],
  [
    Array.from({ length: 17 }, (_, index) => `lib${String(index)}`),
    {
      path: ["source", "install", "extra_packages"],
      reason: "out_of_range",
      maximum: 16,
    },
  ],
])(
  "refuses extra packages %j before rendering a bundle",
  async (extra, issue) => {
    const { runner } = await fakes();
    const client = await connect(runner.environment);
    const refused = parseMcpToolError(
      await client.callTool({
        name: "start_build_computer",
        arguments: {
          source: {
            kind: "request",
            desktop_entry: "freeplane",
            install: {
              kind: "archive",
              package: "freeplane",
              extra_packages: extra,
            },
          },
        },
      }),
    );
    expect(refused.error.code).toBe("invalid_request");
    expect(refused.error.details?.issues).toEqual([
      expect.objectContaining(issue),
    ]);
    expect(await runner.notes("runs.jsonl")).toEqual([]);
  },
);

it("reports the runner's failure with its output and leaves no helper behind", async () => {
  const { runner } = await fakes();
  const client = await connect({
    ...runner.environment,
    FAKE_FAIL: "compose failed: no space left on device",
  });
  const failed = await client.callTool({
    name: "start_build_computer",
    arguments: { source: { kind: "bundle", path: await bundleFolder() } },
  });
  const { error } = parseMcpToolError(failed);
  expect(JSON.stringify(error)).toContain(
    "compose failed: no space left on device",
  );
  // The runner's own stdout went to the diagnostics, not the handshake.
  expect(JSON.stringify(error)).toContain("agentenv writing to stdout");
});

it("points a bundle's start that never got ready at the lock files its seed holds", async () => {
  const { runner } = await fakes();
  const start = async (failure: string, bundle: string) =>
    parseMcpToolError(
      await (
        await connect({ ...runner.environment, FAKE_FAIL: failure })
      ).callTool({
        name: "start_build_computer",
        arguments: { source: { kind: "bundle", path: bundle } },
      }),
    ).error.message;
  const bundle = await bundleFolder();
  const seed = join(bundle, "envs", "calc", "seed");
  await mkdir(join(seed, ".config", "libreoffice", "4"), { recursive: true });
  await mkdir(join(seed, "Documents"));
  await writeFile(join(seed, ".config/libreoffice/4/.lock"), "[Lockdata]\n");
  await writeFile(join(seed, "Documents/.~lock.q1.ods#"), ",user,localhost;\n");
  await writeFile(join(seed, "Documents/q1.ods"), "PK");
  // A lock named for the file beside it, as GnuCash's <book>.LCK; a lone one is no lock.
  await writeFile(join(seed, "Documents/q1.ods.LCK"), "");
  await writeFile(join(seed, "Documents/notes.lck"), "");
  const notReady =
    "envs/calc: container/amd64: failed at probe: it didn't boot: the computer wasn't ready within 180 s (not ready: app calc: no window with class 'libreoffice-calc')";

  const pointed = await start(notReady, bundle);
  const unlocked = await start(notReady, await bundleFolder());
  const otherFailure = await start(
    "compose failed: no space left on device",
    bundle,
  );

  const locks = [
    "envs/calc/seed/.config/libreoffice/4/.lock",
    "envs/calc/seed/Documents/.~lock.q1.ods#",
    "envs/calc/seed/Documents/q1.ods.LCK",
  ];
  expect(pointed).toContain(notReady);
  expect(pointed).toContain(
    "The bundle's seed holds lock files, which can keep the app from starting",
  );
  expect(pointed).toContain(
    "Delete them from the bundle, or export it again, which leaves them out, and start again.",
  );
  for (const lock of locks) expect(pointed).toContain(lock);
  expect(pointed).not.toContain("Documents/notes.lck");
  expect(unlocked).not.toContain(locks[0]);
  expect(otherFailure).not.toContain(locks[0]);
});

it("points a final readiness failure at seeded locks", async () => {
  const { runner } = await fakes({ readinessFails: true });
  const bundle = await bundleFolder();
  const seed = join(bundle, "envs", "calc", "seed", "Documents");
  await mkdir(seed, { recursive: true });
  await writeFile(join(seed, ".~lock.q1.ods#"), "lock");
  const result = await (
    await connect(runner.environment)
  ).callTool({
    name: "start_build_computer",
    arguments: { source: { kind: "bundle", path: bundle } },
  });
  const { error } = parseMcpToolError(result);
  expect(error.message).toContain("display check failed");
  expect(error.message).toContain(".~lock.q1.ods#");
});

it("keeps the end of a long build's output, where its failure is", async () => {
  const { runner } = await fakes();
  const client = await connect({
    ...runner.environment,
    FAKE_CHATTER_BYTES: String(64 * 1024),
    FAKE_FAIL: "Unable to locate package nosuchpkg",
  });
  const failed = await client.callTool({
    name: "start_build_computer",
    arguments: { source: { kind: "bundle", path: await bundleFolder() } },
  });
  const projected = JSON.stringify(parseMcpToolError(failed));
  expect(projected).toContain("E: Unable to locate package nosuchpkg");
  // The package-install chatter before it is what the bound drops.
  expect(projected).not.toContain("chatter 00000:");
});

it("keeps the computer's id when its first screenshot does not fit the response", async () => {
  const { computer, runner } = await fakes({
    frameCharacters: 11 * 1024 * 1024,
  });
  const client = await connect({
    ...runner.environment,
    REA_MCP_MAX_RESPONSE_BYTES: String(10 * 1024 * 1024),
  });
  const refused = parseMcpToolError(
    await client.callTool({
      name: "start_build_computer",
      arguments: { source: { kind: "bundle", path: await bundleFolder() } },
    }),
  );
  const { computer_id: computerId } = z
    .object({ computer_id: z.uuid() })
    .parse(
      z.object({ result: z.unknown() }).parse(refused.error.details).result,
    );
  // The id names the running computer: it can be driven and closed.
  const shot = await client.callTool({
    name: "act_on_build_computer",
    arguments: { computer_id: computerId, action: "wait", ms: 10 },
  });
  expect(shot.isError).not.toBe(true);
  const closed = await client.callTool({
    name: "close_build_computer",
    arguments: { computer_id: computerId },
  });
  expect(closed.structuredContent).toMatchObject({ teardown: "agentenv" });
  expect(computer.calls[0]?.name).toBe("computer_screenshot");
});

it("takes the first screenshot with the caller's options", async () => {
  const { computer, runner } = await fakes();
  const client = await connect(runner.environment);
  const started = await client.callTool({
    name: "start_build_computer",
    arguments: {
      source: { kind: "bundle", path: await bundleFolder() },
      screenshot: { region: [0, 0, 640, 400], format: "jpeg", quality: 40 },
    },
  });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  // The region crops the drawn frame REA waited for.
  expect(computer.calls).toEqual([
    { name: "computer_screenshot", arguments: {} },
    {
      name: "computer_screenshot",
      arguments: { region: [0, 0, 640, 400], format: "jpeg", quality: 40 },
    },
  ]);
});

it("waits for the desktop to draw before it returns the first screenshot", async () => {
  const { computer, runner } = await fakes({ blankFrames: 2 });
  const client = await connect(runner.environment);
  const { started } = await startFromBundle(client, computer);

  expect(images(started)).toEqual([
    { type: "image", data: FAKE_FRAME_PNG, mimeType: "image/png" },
  ]);
  expect(computer.calls).toEqual(
    Array.from({ length: 3 }, () => ({
      name: "computer_screenshot",
      arguments: {},
    })),
  );
});

it("returns the latest frame when a retried screenshot outlasts the wait for the desktop, sending progress meanwhile", async () => {
  // The third screenshot would answer a minute later, well past the 10 s wait.
  const { computer, runner } = await fakes({
    blankFrames: 10_000,
    screenshotDelaysMs: [0, 0, 60_000],
  });
  const client = await connect(runner.environment);
  const progress: { message?: string | undefined }[] = [];
  const startedAt = Date.now();
  const started = await client.callTool(
    {
      name: "start_build_computer",
      arguments: { source: { kind: "bundle", path: await bundleFolder() } },
    },
    { onprogress: (update) => progress.push(update) },
  );

  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  expect(Date.now() - startedAt).toBeLessThan(20_000);
  expect(computer.calls).toHaveLength(3);
  expect(images(started)).toHaveLength(1);
  expect(progress.map(({ message }) => message)).toContainEqual(
    expect.stringContaining("waiting for the desktop to draw"),
  );
});

it("leaves the bundle folder's files as they were when it starts a computer from it", async () => {
  const { runner } = await fakes();
  // Python caches bytecode unless told not to; this host does not tell it.
  const client = await connect({
    ...runner.environment,
    PYTHONDONTWRITEBYTECODE: "",
  });
  const bundle = await bundleFolder();
  await mkdir(join(bundle, "envs", "notes"), { recursive: true });
  await writeFile(
    join(bundle, "envs", "notes", "notes_app.py"),
    "class Notes:\n    pass\n",
  );
  const files = async () => (await readdir(bundle, { recursive: true })).sort();
  const before = await files();

  const id = await startBuildComputer(client, { kind: "bundle", path: bundle });
  await callOk(client, "close_build_computer", { computer_id: id });

  expect(
    await readFile(
      join(runner.state, "bundle", "envs", "notes", "notes_app.py"),
      "utf8",
    ),
  ).toContain("class Notes");
  expect(await files()).toEqual(before);
});

it("refuses to start without an absolute agentenv runner", async () => {
  const client = await connect({ REA_AGENT_ENV_COMMAND: "agent-env" });
  const refused = await client.callTool({
    name: "start_build_computer",
    arguments: { source: { kind: "bundle", path: await bundleFolder() } },
  });
  const { error } = parseMcpToolError(refused);
  expect(error.code).toBe("capability_unavailable");
  expect(JSON.stringify(error)).toContain("REA_AGENT_ENV_COMMAND");
});

it("removes the sandbox's containers by name and label when agentenv's teardown leaves it up", async () => {
  const { computer, runner } = await fakes();
  const docker = join(runner.state, "docker");
  // agentenv runs a computer as agent-<sandbox id> without a label; only its other modes label containers.
  await writeFile(
    docker,
    `#!/bin/sh\necho "$*" >> '${join(runner.state, "docker.log")}'\ncase "$4" in name=*) echo c0ffee ;; label=*) printf 'c0ffee\\nbead00\\n' ;; esac\nexit 0\n`,
  );
  await chmod(docker, 0o755);
  const client = await connect({
    ...runner.environment,
    FAKE_TEARDOWN_FAILS: "1",
    REA_DOCKER_COMMAND: docker,
  });
  const { value } = await startFromBundle(client, computer);
  const closed = await client.callTool({
    name: "close_build_computer",
    arguments: { computer_id: value.computer_id },
  });
  expect(closed.structuredContent).toEqual({
    computer_id: value.computer_id,
    teardown: "container_label",
  });
  expect(
    (await readFile(join(runner.state, "docker.log"), "utf8")).split("\n"),
  ).toEqual([
    "ps -aq --filter name=^agent-sbx-fake$",
    "ps -aq --filter label=agentenv.sandbox=sbx-fake",
    "rm -f c0ffee bead00",
    "",
  ]);
});

it("keeps a computer whose teardown is unconfirmed so close can be retried", async () => {
  const { computer, runner } = await fakes();
  const down = join(runner.state, "docker-down");
  const docker = join(runner.state, "docker");
  await writeFile(down, "");
  await writeFile(
    docker,
    `#!/bin/sh\n[ -e '${down}' ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }\nexit 0\n`,
  );
  await chmod(docker, 0o755);
  const client = await connect({
    ...runner.environment,
    FAKE_TEARDOWN_FAILS: "1",
    REA_DOCKER_COMMAND: docker,
  });
  const { value } = await startFromBundle(client, computer);
  const close = () =>
    client.callTool({
      name: "close_build_computer",
      arguments: { computer_id: value.computer_id },
    });
  const first = parseMcpToolError(await close());
  expect(first.error.code).toBe("cleanup_incomplete");
  expect(JSON.stringify(first)).toContain(
    "Cannot connect to the Docker daemon",
  );
  expect(JSON.stringify(first)).toContain("label=agentenv.sandbox=sbx-fake");
  expect(JSON.stringify(first)).toContain("name=^agent-sbx-fake$");
  // The record stays, so a retry reaches the same sandbox once Docker answers.
  await rm(down);
  expect((await close()).structuredContent).toEqual({
    computer_id: value.computer_id,
    teardown: "container_label",
  });
  expect(await runner.notes("teardowns.jsonl")).toHaveLength(1);
});

it("stops the helper when the caller cancels a start", async () => {
  const { runner } = await fakes();
  const client = await connect({
    ...runner.environment,
    FAKE_DEPLOY_SECONDS: "30",
  });
  const controller = new AbortController();
  const call = client.callTool(
    {
      name: "start_build_computer",
      arguments: { source: { kind: "bundle", path: await bundleFolder() } },
    },
    { signal: controller.signal },
  );
  while ((await runner.notes("runs.jsonl")).length === 0) await delay(50);
  controller.abort();
  await expect(call).rejects.toThrow();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if ((await runner.notes("interrupted.jsonl")).length > 0) break;
    await delay(50);
  }
  expect(await runner.notes("interrupted.jsonl")).toHaveLength(1);
});

/** An app whose reset keeps the computer unready for `polls` readiness polls, 500 ms apart. */
const slowApp = (polls: number): FakeApp => ({
  name: "notes",
  state: {},
  seed: {},
  methods: [],
  unreadyAfterReset: polls,
});

it.each([
  {
    failure: "refuses",
    fail: (computer: FakeComputer) =>
      computer.refuseNext("computer_screenshot", "no display to capture"),
    message: "no display to capture",
  },
  {
    failure: "loses the reply to",
    fail: (computer: FakeComputer) => computer.loseNext("computer_screenshot"),
    message: expect.stringMatching(/\S/),
  },
])(
  "keeps a reset applied when the computer $failure the screenshot after it",
  async ({ fail, message }) => {
    const app = slowApp(0);
    const { computer, runner } = await fakes({ app });
    const client = await connect(runner.environment);
    const id = await startBuildComputer(client, {
      kind: "bundle",
      path: await bundleFolder(),
    });
    fail(computer);
    const reset = await callOk(client, "act_on_build_computer", {
      computer_id: id,
      action: "reset",
      screenshot: true,
    });
    const { result } = toolContract("act_on_build_computer").outputSchema.parse(
      reset.structuredContent,
    );
    expect(result).toEqual({
      reset: true,
      ready_ms: expect.any(Number),
      screenshot_error: message,
    });
    expect(images(reset)).toEqual([]);
    expect(app.methods).toEqual(["data/reset"]);
    expect(computer.calls.map(({ name }) => name).at(-1)).toBe(
      "computer_screenshot",
    );
  },
);

it("runs one computer's calls in the order they arrive and another computer's beside them", async () => {
  const app = slowApp(4);
  const { runner } = await fakes({ app });
  const other = await fakes();
  const client = await connect(runner.environment);
  const first = await startBuildComputer(client, {
    kind: "bundle",
    path: await bundleFolder(),
  });
  const second = await startBuildComputer(client, {
    kind: "bundle",
    path: await bundleFolder(other.computer),
  });
  const act = (id: string, action: string) =>
    callOk(client, "act_on_build_computer", { computer_id: id, action });
  const order: string[] = [];
  const reset = act(first, "reset").then(() => order.push("reset"));
  await waitFor(() => expect(app.methods).toEqual(["data/reset"]));
  const behind = act(first, "screenshot").then(() =>
    order.push("screenshot behind the reset"),
  );
  await act(second, "screenshot");
  order.push("other computer's screenshot");
  await Promise.all([reset, behind]);
  expect(order).toEqual([
    "other computer's screenshot",
    "reset",
    "screenshot behind the reset",
  ]);
});

it("sends progress while an action waits for the call before it on its computer", async () => {
  const app = slowApp(14);
  const { runner } = await fakes({ app });
  const client = await connect(runner.environment);
  const id = await startBuildComputer(client, {
    kind: "bundle",
    path: await bundleFolder(),
  });
  const reset = callOk(client, "act_on_build_computer", {
    computer_id: id,
    action: "reset",
  });
  await waitFor(() => expect(app.methods).toEqual(["data/reset"]));
  const progress: unknown[] = [];
  const waited = await client.callTool(
    {
      name: "act_on_build_computer",
      arguments: { computer_id: id, action: "screenshot" },
    },
    { onprogress: (update) => progress.push(update) },
  );
  expect(waited.isError, JSON.stringify(waited)).not.toBe(true);
  expect(progress.length).toBeGreaterThan(0);
  await reset;
});

it("cancels a computer's call in progress on close and refuses the calls waiting behind it", async () => {
  const app = slowApp(600);
  const { computer, runner } = await fakes({ app });
  const client = await connect(runner.environment);
  const id = await startBuildComputer(client, {
    kind: "bundle",
    path: await bundleFolder(),
  });
  const calls = computer.calls.length;
  const call = (name: string, fields: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: { computer_id: id, ...fields } });
  const reset = call("act_on_build_computer", { action: "reset" });
  await waitFor(() => expect(app.methods).toEqual(["data/reset"]));
  const waiting = [
    call("act_on_build_computer", { action: "screenshot" }),
    call("stop_build_capture"),
  ];
  const closed = await callOk(client, "close_build_computer", {
    computer_id: id,
  });
  expect(closed.structuredContent).toEqual({
    computer_id: id,
    teardown: "agentenv",
  });
  for (const result of await Promise.all([reset, ...waiting]))
    expect(parseMcpToolError(result).error.code).toBe("cancelled");
  expect(computer.calls).toHaveLength(calls);
  expect(app.methods).toEqual(["data/reset"]);
  expect(await runner.notes("teardowns.jsonl")).toHaveLength(1);
  expect(
    parseMcpToolError(await call("act_on_build_computer", { action: "wait" }))
      .error.message,
  ).toContain("start_build_computer");
});
