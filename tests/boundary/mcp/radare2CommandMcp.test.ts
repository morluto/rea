import pino from "pino";
import { expect, it } from "vitest";

import { TestReverseEngineeringService as ReverseEngineeringService } from "../../support/reverseEngineeringService.js";
import { ok } from "../../../src/domain/result.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";
import { registerReverseEngineeringTools } from "../../../src/server/registerReverseEngineeringTools.js";
import {
  createReverseEngineeringMcpHarness,
  invokeWithLiveSignal,
} from "../../support/reverseEngineeringMcpHarness.js";

it("returns radare2 evidence through the MCP tool", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    run: async () => ({ stdout: "r2 output", stderr: "" }),
  });
  registerReverseEngineeringTools(
    server,
    service,
    pino({ enabled: false }),
    createToolResultDelivery(2 * 1024 * 1024),
  );
  const invoke = handler("execute_radare2_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
    command: "ij",
  })) as {
    readonly isError?: boolean;
    readonly structuredContent?: Readonly<Record<string, unknown>>;
  };

  expect(response.isError).not.toBe(true);
  expect(JSON.stringify(response.structuredContent).includes('"radare2"')).toBe(
    true,
  );
  expect(JSON.stringify(response.structuredContent)).toContain("r2 output");
});

it("reports a missing radare2 executable as an unavailable capability", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    environment: { REA_R2_COMMAND: "/nonexistent/radare2" },
  });
  registerReverseEngineeringTools(
    server,
    service,
    pino({ enabled: false }),
    createToolResultDelivery(2 * 1024 * 1024),
  );
  const invoke = handler("execute_radare2_command");

  const response = (await invokeWithLiveSignal(invoke, {
    path: "package.json",
    command: "ij",
  })) as {
    readonly isError?: boolean;
    readonly structuredContent?: {
      readonly error?: {
        readonly code?: string;
        readonly details?: Readonly<Record<string, unknown>>;
      };
    };
  };

  expect(response.isError).toBe(true);
  expect(response.structuredContent?.error?.code).toBe(
    "capability_unavailable",
  );
  expect(response.structuredContent?.error?.details).toMatchObject({
    provider_id: "radare2",
  });
});

it("admits radare2 mutation after invalidating before dispatch", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const events: string[] = [];
  const service = new ReverseEngineeringService({
    run: async () => {
      events.push("dispatch");
      return { stdout: "r2 output", stderr: "" };
    },
  });
  registerReverseEngineeringTools(
    server,
    service,
    pino({ enabled: false }),
    createToolResultDelivery(2 * 1024 * 1024),
    undefined,
    undefined,
    () => events.push("invalidate"),
    async (_path, _signal, operation) => {
      events.push("admit");
      return ok(await operation());
    },
  );
  const invoke = handler("execute_radare2_command");

  await invoke(
    { path: "package.json", command: "ij" },
    { mcpReq: { signal: new AbortController().signal } },
  );

  expect(events).toEqual(["admit", "invalidate", "dispatch"]);
});

it("passes the radare2 operation name to admitted external mutations", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    run: async () => ({ stdout: "r2 output", stderr: "" }),
  });
  const admittedNames: Array<string | undefined> = [];
  registerReverseEngineeringTools(
    server,
    service,
    pino({ enabled: false }),
    createToolResultDelivery(2 * 1024 * 1024),
    undefined,
    undefined,
    undefined,
    async (_path, _signal, operation, _rebindFailure, operationName) => {
      admittedNames.push(operationName);
      return ok(await operation());
    },
  );
  const invoke = handler("execute_radare2_command");

  await invokeWithLiveSignal(invoke, { path: "package.json", command: "ij" });

  expect(admittedNames).toEqual(["execute_radare2_command"]);
});
