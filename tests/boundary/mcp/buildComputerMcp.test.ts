import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import {
  FAKE_FRAME_PNG,
  fakeAgentEnvRunner,
  startFakeComputer,
  type FakeComputer,
  type FakeComputerOptions,
} from "../../fixtures/fakeAgentEnvComputer.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** The host's environment without the settings the opt-in real test exports, which would reach past these fakes. */
const hostEnvironment = Object.fromEntries(
  Object.entries(process.env).filter(
    ([name]) =>
      ![
        "REA_AGENT_ENV_COMMAND",
        "REA_DOCKER_COMMAND",
        "REA_BUILD_COMPUTER_REA_ARCHIVE",
      ].includes(name),
  ),
);

const connect = async (environment: Readonly<Record<string, string>>) => {
  const session = createTestBinarySession(() => {
    throw new Error("build computers must not start a deep provider");
  });
  const server = createServer(
    { kind: "session", session },
    {
      environment: {
        ...hostEnvironment,
        REA_MCP_INPUT_SCHEMA_PROFILE: "full",
        ...environment,
      },
    },
  );
  const client = new Client({ name: "build-computer-mcp", version: "1" });
  onTestFinished(async () => {
    await client.close();
    await server.close();
    await session.close();
  });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return client;
};

const fakes = async (options: FakeComputerOptions = {}) => {
  const computer = await startFakeComputer(options);
  onTestFinished(() => computer.close());
  const runner = await fakeAgentEnvRunner(computer);
  return { computer, runner };
};

const bundleFolder = async (): Promise<string> => {
  const bundle = await createTestTempDirectory("exported-bundle-");
  await mkdir(join(bundle, "tasks"));
  await writeFile(join(bundle, "tasks", "smoke.json"), "[]\n");
  return bundle;
};

const images = (result: CallToolResult) =>
  result.content.filter((block) => block.type === "image");

/** No delivered text, success or failure, may hold the control token. */
const expectNoToken = (computer: FakeComputer, result: CallToolResult) =>
  expect(JSON.stringify(result)).not.toContain(computer.token);

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
        install: { kind: "archive", package: "mousepad" },
      },
    },
  });
  expect(started.isError, JSON.stringify(started)).not.toBe(true);
  expect(started.structuredContent).toMatchObject({ environment: "mousepad" });
  const env = join(runner.state, "bundle", "envs", "mousepad");
  expect(await readFile(join(env, "rea-payload.tar"), "utf8")).toBe(
    "a packed REA build",
  );
  expect(await readFile(join(env, "mousepad_app.py"), "utf8")).toContain(
    'Launch(at="demand"',
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
  expect(computer.calls[0]).toEqual({
    name: "computer_screenshot",
    arguments: { region: [0, 0, 640, 400], format: "jpeg", quality: 40 },
  });
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
