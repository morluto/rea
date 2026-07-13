import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import { BinarySession } from "../src/application/BinarySession.js";
import { PROMPT_CONTRACTS } from "../src/contracts/promptContracts.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createServer } from "../src/server/createServer.js";
import { registerGuidedPrompts } from "../src/server/registerPrompts.js";
import { observed } from "./fixtures/analysisExecution.js";

const resources: Array<{ close(): Promise<unknown> }> = [];

afterEach(async () => {
  await Promise.allSettled(
    resources.splice(0).map((resource) => resource.close()),
  );
});

describe("guided prompts over MCP", () => {
  it("lists and renders all workflows without changing the tool inventory", async () => {
    const session = fixtureSession();
    const client = await connect(createServer(session, session));
    resources.push(session);

    const prompts = await client.listPrompts();
    expect(prompts.prompts.map(({ name }) => name)).toEqual(
      PROMPT_CONTRACTS.map(({ name }) => name),
    );
    expect((await client.listTools()).tools).toHaveLength(68);
    const result = await client.getPrompt({
      name: "investigate_feature",
      arguments: {
        feature: "license validation",
        document: "App",
      },
    });
    const content = result.messages[0]?.content;
    expect(content?.type).toBe("text");
    if (content?.type !== "text") throw new Error("missing prompt text");
    expect(content.text).toContain('"feature":"license validation"');
    expect(content.text).toContain("`trace_feature`");
    expect(content.text).toContain("incomplete pagination");
    const audit = await client.getPrompt({
      name: "audit_residual_unknowns",
      arguments: { audit_scope: "all active release blockers" },
    });
    expect(audit.messages[0]?.content.type).toBe("text");
  });

  it("applies the MCP 100-value limit while reporting total and hasMore", async () => {
    const session = fixtureSession();
    for (let index = 0; index < 150; index += 1)
      expect(
        session.recordEvidence(
          createEvidence(undefined, fixtureProvider, {
            operation: `fixture-${String(index)}`,
            parameters: { index },
            result: index,
            confidence: "derived",
            authority: "analyst-inference",
          }),
        ).ok,
      ).toBe(true);
    const client = await connect(createServer(session, session));
    resources.push(session);

    const result = await client.complete({
      ref: { type: "ref/prompt", name: "verify_reconstruction" },
      argument: { name: "comparison_evidence_id", value: "ev_" },
    });
    expect(result.completion.values).toHaveLength(100);
    expect(result.completion.total).toBe(150);
    expect(result.completion.hasMore).toBe(true);
    expect(result.completion.values).toEqual(
      [...result.completion.values].sort(),
    );
  });

  it("emits prompts/list_changed and exposes the updated prompt", async () => {
    const session = fixtureSession();
    const server = new McpServer({
      name: "prompt-registry-test",
      version: "1",
    });
    const registry = registerGuidedPrompts(server, session, session);
    const client = new Client({ name: "prompt-registry-client", version: "1" });
    const changed = new Promise<void>((resolve) => {
      client.setNotificationHandler("notifications/prompts/list_changed", () =>
        resolve(),
      );
    });
    await connectPair(server, client);
    resources.push(session);

    registry.update({
      ...PROMPT_CONTRACTS[0],
      title: "Investigate a feature (updated)",
    });
    await changed;
    const prompts = await client.listPrompts(undefined, {
      cacheMode: "refresh",
    });
    expect(prompts.prompts[0]?.title).toBe("Investigate a feature (updated)");
  });
});

const fixtureProvider = { id: "fixture", name: "Fixture", version: "1" };

const fixtureSession = (): BinarySession =>
  new BinarySession(() => ({
    execute: () => Promise.resolve(observed(null)),
    close: () => Promise.resolve(),
  }));

const connect = async (
  server: Awaited<ReturnType<typeof createServer>>,
): Promise<Client> => {
  const client = new Client({ name: "prompt-test", version: "1" });
  await connectPair(server, client);
  return client;
};

const connectPair = async (
  server: McpServer,
  client: Client,
): Promise<void> => {
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  resources.push(client, server);
  await server.connect(serverTransport);
  await client.connect(clientTransport);
};
