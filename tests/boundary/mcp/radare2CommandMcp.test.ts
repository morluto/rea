import { expect, it } from "vitest";

import { TestReverseEngineeringService as ReverseEngineeringService } from "../../support/reverseEngineeringService.js";
import { ownedOutput } from "../../support/reverseEngineeringCompositionFixtures.js";
import { ok } from "../../../src/domain/result.js";
import type { ExternalMutationAdmission } from "../../../src/server/externalMutationAdmission.js";
import {
  createReverseEngineeringMcpHarness,
  invokeWithLiveSignal,
  registerReverseEngineeringTools,
} from "../../support/reverseEngineeringMcpHarness.js";

it("returns radare2 evidence through the MCP tool", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    runOwned: async () => ownedOutput("r2 output"),
  });
  registerReverseEngineeringTools(server, service);
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
  registerReverseEngineeringTools(server, service);
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

it("admits radare2 mutation through the bound session before dispatch", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const events: string[] = [];
  const service = new ReverseEngineeringService({
    runOwned: async () => {
      events.push("dispatch");
      return ownedOutput("r2 output");
    },
  });
  const session: ExternalMutationAdmission = {
    withAdmittedExternalMutation: async (_path, _signal, operation) => {
      events.push("admit");
      return ok(await operation());
    },
  };
  registerReverseEngineeringTools(server, service, { session });
  const invoke = handler("execute_radare2_command");

  await invoke(
    { path: "package.json", command: "ij" },
    { mcpReq: { signal: new AbortController().signal } },
  );

  expect(events).toEqual(["admit", "dispatch"]);
});

it("passes the radare2 operation name to admitted external mutations", async () => {
  const { server, handler } = createReverseEngineeringMcpHarness();
  const service = new ReverseEngineeringService({
    runOwned: async () => ownedOutput("r2 output"),
  });
  const admittedNames: Array<string | undefined> = [];
  const session: ExternalMutationAdmission = {
    withAdmittedExternalMutation: async (
      _path,
      _signal,
      operation,
      _completionFailure,
      operationName,
    ) => {
      admittedNames.push(operationName);
      return ok(await operation());
    },
  };
  registerReverseEngineeringTools(server, service, { session });
  const invoke = handler("execute_radare2_command");

  await invokeWithLiveSignal(invoke, { path: "package.json", command: "ij" });

  expect(admittedNames).toEqual(["execute_radare2_command"]);
});
