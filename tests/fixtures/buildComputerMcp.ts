import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { expect, onTestFinished } from "vitest";

import { toolContract } from "../../src/contracts/toolContracts.js";
import { createServer } from "../../src/server/createServer.js";
import { createTestBinarySession } from "./binarySession.js";
import {
  fakeAgentEnvRunner,
  startFakeComputer,
  type FakeAgentEnvRunner,
  type FakeComputer,
  type FakeComputerOptions,
} from "./fakeAgentEnvComputer.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** The host's environment without the settings the opt-in real test exports, which would reach past the fakes. */
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

/** An MCP client of a REA server whose build computers reach the fakes through `environment`. */
export const connectBuildServer = async (
  environment: Readonly<Record<string, string>>,
): Promise<Client> => {
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

/** A fake computer and the fake runner that hands it out. */
export const buildComputerFakes = async (
  options: FakeComputerOptions = {},
): Promise<{ computer: FakeComputer; runner: FakeAgentEnvRunner }> => {
  const computer = await startFakeComputer(options);
  onTestFinished(() => computer.close());
  const runner = await fakeAgentEnvRunner(computer);
  return { computer, runner };
};

/** An exported bundle's folder as far as the fake runner reads it. */
export const bundleFolder = async (): Promise<string> => {
  const bundle = await createTestTempDirectory("exported-bundle-");
  await mkdir(join(bundle, "tasks"));
  await writeFile(join(bundle, "tasks", "smoke.json"), "[]\n");
  return bundle;
};

/** Call a tool and fail the test with its result when it is an error. */
export const callOk = async (
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<CallToolResult> => {
  const result = await client.callTool({ name, arguments: args });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result as CallToolResult;
};

/** Start a build computer and return its id. */
export const startBuildComputer = async (
  client: Client,
  source: Record<string, unknown>,
): Promise<string> =>
  toolContract("start_build_computer").outputSchema.parse(
    (await callOk(client, "start_build_computer", { source }))
      .structuredContent,
  ).computer_id;

/** No delivered text, success or failure, may hold the control token. */
export const expectNoToken = (computer: FakeComputer, result: unknown) =>
  expect(JSON.stringify(result)).not.toContain(computer.token);
