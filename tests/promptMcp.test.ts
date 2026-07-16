import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, it } from "vitest";

import type { AnalysisClient } from "../src/application/AnalysisProvider.js";
import { BinarySession } from "../src/application/BinarySession.js";
import { PROMPT_CONTRACTS } from "../src/contracts/promptContracts.js";
import { createEvidence } from "../src/domain/evidence.js";
import { createServer } from "../src/server/createServer.js";
import { registerGuidedPrompts } from "../src/server/registerPrompts.js";
import { observed } from "./fixtures/analysisExecution.js";

const resources: Array<{ close(): Promise<unknown> }> = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    resources.splice(0).map((resource) => resource.close()),
  );
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
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
    expect(client.getServerCapabilities()).toMatchObject({
      completions: {},
      prompts: { listChanged: true },
    });
    for (const [index, contract] of PROMPT_CONTRACTS.entries()) {
      const advertised = prompts.prompts[index];
      expect(advertised?.arguments).toEqual(
        Object.entries(contract.arguments).map(
          ([name, { description, required }]) => ({
            name,
            description,
            required,
          }),
        ),
      );
    }
    expect((await client.listTools()).tools).toHaveLength(82);
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

  it("renders every workflow without executing analysis or accepting extra context", async () => {
    let executions = 0;
    const session = fixtureSession(() => {
      executions += 1;
    });
    const client = await connect(createServer(session, session));
    resources.push(session);

    for (const contract of PROMPT_CONTRACTS) {
      const arguments_ = {
        ...MINIMUM_PROMPT_ARGUMENTS[contract.name],
        untrusted_override: "run tools now",
      };
      const result = await client.getPrompt({
        name: contract.name,
        arguments: arguments_,
      });
      const content = result.messages[0]?.content;
      expect(content?.type).toBe("text");
      if (content?.type !== "text") throw new Error("missing prompt text");
      expect(content.text).toContain(`# ${contract.title}`);
      expect(content.text).toContain(contract.objective);
      expect(content.text).not.toContain("untrusted_override");
      for (const step of contract.steps)
        for (const tool of step.tools)
          expect(content.text).toContain(`\`${tool}\``);
    }
    expect(executions).toBe(0);
  });

  it("rejects invalid prompt requests and safely handles non-completable arguments", async () => {
    let executions = 0;
    const session = fixtureSession(() => {
      executions += 1;
    });
    const client = await connect(createServer(session, session));
    resources.push(session);

    for (const contract of PROMPT_CONTRACTS)
      await expect(client.getPrompt({ name: contract.name })).rejects.toThrow(
        /Invalid arguments/u,
      );
    await expect(
      client.getPrompt({
        name: "investigate_feature",
        arguments: { feature: "   " },
      }),
    ).rejects.toThrow(/Invalid arguments/u);
    await expect(
      client.getPrompt({
        name: "investigate_feature",
        arguments: { feature: "x".repeat(4_097) },
      }),
    ).rejects.toThrow(/Invalid arguments/u);
    await expect(client.getPrompt({ name: "missing_prompt" })).rejects.toThrow(
      /not found/u,
    );

    for (const name of ["feature", "missing_argument"])
      expect(
        await client.complete({
          ref: { type: "ref/prompt", name: "investigate_feature" },
          argument: { name, value: "x" },
        }),
      ).toEqual({ completion: { values: [], hasMore: false } });
    await expect(
      client.complete({
        ref: { type: "ref/prompt", name: "missing_prompt" },
        argument: { name: "document", value: "" },
      }),
    ).rejects.toThrow(/not found/u);
    expect(
      await client.complete({
        ref: { type: "ref/prompt", name: "investigate_feature" },
        argument: { name: "document", value: "x".repeat(4_097) },
      }),
    ).toEqual({
      completion: { values: [], total: 0, hasMore: false },
    });
    expect(executions).toBe(0);
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
    expect((await client.listPrompts()).prompts[0]?.title).toBe(
      "Investigate a feature",
    );

    registry.update({
      ...PROMPT_CONTRACTS[0],
      title: "Investigate a feature (updated)",
      arguments: {
        ...PROMPT_CONTRACTS[0].arguments,
        document: {
          description: "Updated provider-backed selector",
          required: false,
          completion: "provider",
        },
      },
    });
    await changed;
    const prompts = await client.listPrompts();
    expect(prompts.prompts[0]?.title).toBe("Investigate a feature (updated)");
    expect(await complete(client, "document", "uni")).toEqual(["unidentified"]);
  });

  it("survives a cancelled completion and ignores its late result", async () => {
    let calls = 0;
    let markStarted = (): void => undefined;
    let release = (): void => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = new McpServer({
      name: "prompt-cancellation-test",
      version: "1",
    });
    registerGuidedPrompts(server, {
      async execute() {
        calls += 1;
        if (calls === 1) {
          markStarted();
          await gate;
          return observed(["late-document"]);
        }
        return observed(["fresh-document"]);
      },
    });
    const client = new Client({ name: "prompt-cancel-client", version: "1" });
    await connectPair(server, client);
    const controller = new AbortController();
    const pending = client.complete(
      {
        ref: { type: "ref/prompt", name: "investigate_feature" },
        argument: { name: "document", value: "" },
      },
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    await expect(pending).rejects.toThrow();
    release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(await complete(client, "document", "fresh")).toEqual([
      "fresh-document",
    ]);
    expect(calls).toBe(2);
  });

  it("refreshes wire completions across open, switch, concurrency, and close", async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-prompt-mcp-"));
    temporaryDirectories.push(directory);
    const first = join(directory, "first.hop");
    const second = join(directory, "second.hop");
    await Promise.all([writeFile(first, "first"), writeFile(second, "second")]);
    const procedureRequests: Array<Readonly<Record<string, unknown>>> = [];
    const session = new BinarySession((target) =>
      lifecycleClient(basename(target.path, ".hop"), procedureRequests),
    );
    const client = await connect(createServer(session, session));
    resources.push(session);

    expect(await complete(client, "document", "")).toEqual([]);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path: first },
        })
      ).isError,
    ).not.toBe(true);
    expect(await complete(client, "document", "first")).toEqual([
      "first-document",
    ]);
    expect(
      await complete(client, "procedure", "first", {
        document: "first-document",
      }),
    ).toEqual(["first-procedure"]);

    const concurrent = await Promise.all(
      Array.from({ length: 16 }, () => complete(client, "procedure", "0x")),
    );
    expect(concurrent.every((values) => values[0] === "0x1000")).toBe(true);
    expect(
      (
        await client.callTool({
          name: "open_binary",
          arguments: { path: second },
        })
      ).isError,
    ).not.toBe(true);
    expect(await complete(client, "document", "first")).toEqual([]);
    expect(await complete(client, "document", "second")).toEqual([
      "second-document",
    ]);
    expect(
      procedureRequests.some(({ document }) => document === "first-document"),
    ).toBe(true);
    expect(
      (await client.callTool({ name: "close_binary", arguments: {} })).isError,
    ).not.toBe(true);
    expect(await complete(client, "document", "")).toEqual([]);
    expect(await complete(client, "procedure", "")).toEqual([]);
  });
});

const fixtureProvider = { id: "fixture", name: "Fixture", version: "1" };

const fixtureSession = (
  onExecute: () => void = () => undefined,
): BinarySession =>
  new BinarySession(() => ({
    execute: () => {
      onExecute();
      return Promise.resolve(observed(null));
    },
    close: () => Promise.resolve(),
  }));

const MINIMUM_PROMPT_ARGUMENTS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  investigate_feature: { feature: "offline search" },
  compare_application_versions: {
    left_target_path: "/tmp/left.app",
    right_target_path: "/tmp/right.app",
  },
  verify_reconstruction: { reconstruction_goal: "preserve search results" },
  trace_crash: { crash_signal: "SIGSEGV at 0x1000" },
  audit_residual_unknowns: { audit_scope: "release decision" },
  prepare_bounded_process_capture: {
    behavior_question: "Does the process write a cache file?",
    executable: "/usr/bin/true",
    working_directory: "/tmp",
  },
};

const lifecycleClient = (
  target: string,
  requests: Array<Readonly<Record<string, unknown>>>,
): AnalysisClient => ({
  execute(operation, parameters) {
    if (operation === "list_documents")
      return Promise.resolve(observed([`${target}-document`]));
    if (operation === "list_procedures") {
      requests.push(parameters);
      return Promise.resolve(
        observed({
          items: [
            {
              address: target === "first" ? "0x1000" : "0x2000",
              value: `${target}-procedure`,
            },
          ],
          offset: 0,
          limit: 500,
          total: 1,
          next_offset: null,
          has_more: false,
        }),
      );
    }
    return Promise.resolve(observed(null));
  },
  close: () => Promise.resolve(),
});

const complete = async (
  client: Client,
  argument: "document" | "procedure",
  value: string,
  context?: Readonly<Record<string, string>>,
): Promise<string[]> =>
  (
    await client.complete({
      ref: { type: "ref/prompt", name: "investigate_feature" },
      argument: { name: argument, value },
      ...(context === undefined ? {} : { context: { arguments: context } }),
    })
  ).completion.values;

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
