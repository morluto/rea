import type { Client } from "@modelcontextprotocol/client";
import { onTestFinished } from "vitest";

import { closeVerifierResources } from "../../scripts/lib/verifier-cleanup.mjs";
import { ok as resultOk } from "../../src/domain/result.js";
import { createTestBinarySession } from "./binarySession.js";
import type { BinarySession } from "../../src/application/binary/BinarySession.js";
import { observed } from "./analysisExecution.js";
import { INLINE_EVIDENCE_MCP_ENVIRONMENT } from "../../scripts/lib/mcp-verification-environment.mjs";
import { createServer } from "../../src/server/createServer.js";
import { AGENT_RESULT_BUDGET_SETTING } from "../../src/domain/agentResultBudget.js";
import { MAXIMUM_AGENT_RESULT_BUDGET_BYTES } from "../../src/domain/analysisResourceLimits.js";
import {
  createTestMcp,
  type McpClientIdentity,
  type TestMcp,
} from "../support/mcp/mcpFixture.js";

/** Owned MCP SDK session shared by application workflow scenarios. */
export interface ApplicationMcpHarness {
  readonly client: Client;
  readonly session: BinarySession;
  readonly close: () => Promise<void>;
}

/** Connect complete-Evidence workflow fixtures through production registration. */
export async function createApplicationMcpHarness(
  options: {
    readonly session?: BinarySession;
    readonly serverOptions?: Parameters<typeof createServer>[1];
    readonly clientIdentity?: McpClientIdentity;
    readonly schemaValidator?: Parameters<TestMcp["connect"]>[2];
    readonly registerCleanup?: (close: ApplicationMcpHarness["close"]) => void;
    /**
     * Complete-Evidence workflows chain inline Evidence, so the harness
     * raises the agent result budget to its maximum unless a test keeps the
     * default to observe budgeted delivery.
     */
    readonly agentResultBudget?: "maximum" | "default";
  } = {},
): Promise<ApplicationMcpHarness> {
  const session =
    options.session ??
    createTestBinarySession(() => ({
      execute: () => Promise.resolve(observed(null)),
      close: () => Promise.resolve(resultOk(null)),
    }));
  const mcp = createTestMcp();
  let sessionClosed = false;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing !== undefined) return closing;
    const attempt = closeVerifierResources([
      () => mcp.close(),
      async () => {
        if (sessionClosed) return;
        const result = await session.close();
        if (!result.ok) throw result.error;
        sessionClosed = true;
      },
    ]);
    closing = attempt;
    void attempt.catch(() => {
      if (closing === attempt) closing = undefined;
    });
    return attempt;
  };
  onTestFinished(close);

  try {
    options.registerCleanup?.(close);
    const server = createServer(
      { kind: "session", session },
      {
        ...options.serverOptions,
        environment: {
          ...INLINE_EVIDENCE_MCP_ENVIRONMENT,
          ...(options.serverOptions?.environment ?? process.env),
        },
      },
    );
    const client = await mcp.connect(
      server,
      options.clientIdentity ?? {
        name: "application-workflow-test",
        version: "1",
      },
      options.schemaValidator,
    );
    if (options.agentResultBudget !== "default") {
      const raised = await client.callTool({
        name: "update_analysis_settings",
        arguments: {
          changes: [
            {
              setting: AGENT_RESULT_BUDGET_SETTING,
              action: "set",
              value: MAXIMUM_AGENT_RESULT_BUDGET_BYTES,
            },
          ],
        },
      });
      if (raised.isError === true)
        throw new Error("The harness could not raise the agent result budget");
    }
    return { client, session, close };
  } catch (cause) {
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError(
        [cause, cleanup],
        "Application MCP harness setup and cleanup failed",
        { cause },
      );
    }
    throw cause;
  }
}
