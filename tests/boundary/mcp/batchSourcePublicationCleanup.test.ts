import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createAnalysisExecution } from "../../../src/application/AnalysisProvider.js";
import { BinarySession } from "../../../src/application/binary/BinarySession.js";
import { InvestigationRecords } from "../../../src/application/investigation/InvestigationRecords.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";
import { err, ok } from "../../../src/domain/result.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestProviderRouter } from "../../fixtures/binarySession.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { awaitAcknowledgement } from "../../fixtures/lifecycleAcknowledgement.js";

const expectRecoveredBatch = (response: CallToolResult, owned: string) => {
  expect(parseMcpToolError(response).error).toMatchObject({
    code: "resource_constraint",
    details: {
      completed_observation: {
        evidence: {
          normalized_result: {
            items: [
              { status: "ok" },
              {
                status: "error",
                error: {
                  code: "cleanup_incomplete",
                  details: { resources: [owned] },
                },
              },
            ],
          },
        },
      },
    },
  });
};

it("keeps a mixed batch cleanup owner after source retention fails and retries it", async () => {
  const root = await createTestTempDirectory("rea-batch-owned-cleanup-");
  const target = join(root, "fixture.com"),
    owned = join(root, "owned");
  await writeFile(target, Buffer.from([0xb8, 0, 0x4c, 0xcd, 0x21]));
  const provider = { id: "fixture", name: "Fixture", version: "1" };
  const source = createEvidence(undefined, provider, {
    operation: "health",
    parameters: {},
    result: "source",
  });
  const failure = new ProviderCleanupError(provider.id, [owned], {
    reason: "controlled cleanup failure",
  });
  let count = 0,
    pending = false,
    allow = false,
    closes = 0;
  let entered!: () => void;
  let release!: () => void;
  const closing = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const session = new BinarySession(
    createTestProviderRouter(() => ({
      execute: async (operation) => {
        if (operation === "procedure_pseudo_code" && ++count === 2) {
          await mkdir(owned);
          pending = true;
          return err(failure);
        }
        return ok(
          createAnalysisExecution(
            operation === "procedure_address"
              ? "0x100"
              : operation === "address_name"
                ? "example"
                : operation === "health"
                  ? null
                  : "int example(void) { return 1; }",
            provider,
          ),
        );
      },
      close: async () => {
        closes++;
        if (!pending) return ok(null);
        if (closes === 2) {
          entered();
          await gate;
          return err(failure);
        }
        if (!allow) return err(failure);
        await rm(owned, { recursive: true });
        pending = false;
        failure.resolveCleanup();
        return ok(null);
      },
    })),
    new InvestigationRecords({ maximumRepresentationBytes: 0 }),
  );
  const admit = session.withAdmittedAnalysis.bind(session);
  vi.spyOn(session, "withAdmittedAnalysis").mockImplementation(
    (operation, signal, run) =>
      admit(operation, signal, (analysis) =>
        run({
          ...analysis,
          execute: async (...args) => {
            const result = await analysis.execute(...args);
            if (args[0] === "procedure_pseudo_code" && result.ok)
              return {
                ...result,
                value: { ...result.value, sourceEvidence: [source] },
              };
            return result;
          },
        }),
      ),
  );
  const server = createServer({ kind: "session", session });
  const client = new Client({ name: "batch-owned-cleanup", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await server.connect(st);
    await client.connect(ct);
    const call = (name: string, args: Record<string, unknown> = {}) =>
      client.callTool({ name, arguments: args }, { timeout: 120000 });
    expect(
      (await call("open_binary", { path: target, format: "dos-com" })).isError,
    ).not.toBe(true);
    const response = await call("batch_decompile", {
      addresses: ["first", "second"],
    });
    expectRecoveredBatch(response, owned);
    expect(pending).toBe(true);
    expect(failure.cleanupIncomplete).toBe(true);
    await expect(access(owned)).resolves.toBeUndefined();
    const close1 = await call("close_binary");
    expect(close1.isError).toBe(true);
    expect(parseMcpToolError(close1).error).toMatchObject({
      code: "cleanup_incomplete",
      recovery: { kind: "retry_cleanup", operation: "close_binary" },
      details: { resources: [owned] },
    });
    expect(pending).toBe(true);
    const controller = new AbortController();
    const cancelledClose = client.callTool(
      { name: "close_binary", arguments: {} },
      { signal: controller.signal, timeout: 120000 },
    );
    try {
      await awaitAcknowledgement(closing, cancelledClose, "final cleanup");
      controller.abort();
      await expect(cancelledClose).rejects.toThrow();
    } finally {
      controller.abort();
      release();
      await Promise.allSettled([cancelledClose]);
    }
    allow = true;
    const close2 = await call("close_binary");
    expect(close2.isError).not.toBe(true);
    expect(pending).toBe(false);
    expect(failure.cleanupIncomplete).toBe(false);
    expect(closes).toBe(3);
    await expect(access(owned)).rejects.toThrow();
  } finally {
    allow = true;
    release();
    await client.close();
    await server.close();
    await session.close();
    vi.restoreAllMocks();
  }
});
