import type { StdioServerHandle } from "@modelcontextprotocol/server/stdio";
import pino from "pino";
import { expect, it } from "vitest";

import { createManagedBinarySession } from "../../../src/composition/binary.js";
import { MCP_SHUTDOWN_FAILED } from "../../../src/main/messages.js";
import { createShutdown } from "../../../src/main/shutdown.js";
import type { RuntimeDependencies } from "../../../src/main/types.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { observed } from "../../fixtures/analysisExecution.js";
import {
  createBinarySessionTargets,
  createTestBinarySession,
} from "../../fixtures/binarySession.js";

it("keeps shutdown output stable while logging the rejected cause at debug level", async () => {
  const logs: string[] = [];
  const output: string[] = [];
  const exitCodes: number[] = [];
  const requests: Array<() => void> = [];
  let androidClosed = false;
  const failure = Object.assign(
    new TypeError("fixture transport close failed"),
    {
      code: "ECONNRESET",
    },
  );
  const handle: StdioServerHandle = {
    close: () => Promise.reject(failure),
  };
  const dependencies: RuntimeDependencies = {
    env: {},
    serve: () => {
      throw new Error("unused fixture transport");
    },
    writeStderr: (text) => output.push(text),
    setExitCode: (code) => exitCodes.push(code),
    registerShutdown: (request) => {
      requests.push(request);
      return () => undefined;
    },
  };
  const logger = pino({ level: "debug" }, { write: (line) => logs.push(line) });
  createShutdown({
    handle,
    closeAndroid: async () => {
      androidClosed = true;
    },
    session: createManagedBinarySession(),
    dependencies,
    serverLogger: logger,
  });

  requests[0]?.();
  await new Promise((resolve) => setImmediate(resolve));

  expect(exitCodes).toEqual([1]);
  expect(androidClosed).toBe(true);
  expect(output).toEqual([`${MCP_SHUTDOWN_FAILED}\n`]);
  expect(logs.map((line) => JSON.parse(line))).toContainEqual(
    expect.objectContaining({
      level: 20,
      msg: "MCP shutdown rejected",
      failure_cause: {
        name: "TypeError",
        message: "fixture transport close failed",
        code: "ECONNRESET",
      },
    }),
  );
});

it("reports a typed binary cleanup failure and retains the client for retry", async () => {
  const [target] = await createBinarySessionTargets();
  const failure = new ProviderCleanupError("fixture", ["owned-runtime"], {
    reason: "fixture removal denied",
  });
  let cleanupAllowed = false;
  let retainDocument: boolean | undefined;
  const session = createTestBinarySession(() => ({
    execute: async () => observed(null),
    close: async (options) => {
      retainDocument = options?.retainDocument;
      return cleanupAllowed ? ok(null) : err(failure);
    },
  }));
  expect((await session.open(target)).ok).toBe(true);
  const output: string[] = [];
  const exitCodes: number[] = [];
  const requests: Array<() => void> = [];
  const dependencies: RuntimeDependencies = {
    env: {},
    serve: () => {
      throw new Error("unused fixture transport");
    },
    writeStderr: (text) => output.push(text),
    setExitCode: (code) => exitCodes.push(code),
    registerShutdown: (request) => {
      requests.push(request);
      return () => undefined;
    },
  };
  createShutdown({
    handle: { close: async () => undefined },
    session,
    dependencies,
    serverLogger: pino({ enabled: false }),
  });
  requests[0]?.();
  await new Promise((resolve) => setImmediate(resolve));
  expect(exitCodes).toEqual([1]);
  expect(output).toEqual([
    `${MCP_SHUTDOWN_FAILED}\n`,
    `${failure.userMessage}\n`,
  ]);
  expect(retainDocument).toBe(true);
  cleanupAllowed = true;
  expect((await session.close()).ok).toBe(true);
});
