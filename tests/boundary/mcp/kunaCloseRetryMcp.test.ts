import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it as test } from "vitest";

import { toolContract } from "../../../src/contracts/toolContracts.js";
import { cleanupRetryRemediation } from "../../../src/domain/analysisErrorRecovery.js";
import { silentLogger } from "../../../src/logger.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  exportsOf,
  session as kunaSession,
  unprovenCleanupLauncher,
} from "../providers/kuna/kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");

/** Minimal ELF64 x86-64 header; the fake Kuna never parses the program. */
const elfProgram = (): Buffer => {
  const header = Buffer.alloc(64);
  header.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1], 0);
  header.writeUInt16LE(3, 16);
  header.writeUInt16LE(0x3e, 18);
  header.writeUInt32LE(1, 20);
  header.writeUInt16LE(header.length, 52);
  return header;
};

const sessionStatus = async (client: Client) =>
  toolContract("binary_session").outputSchema.parse(
    (await client.callTool({ name: "binary_session", arguments: {} }))
      .structuredContent,
  ).result;

it("names the same-connection close_binary retry for an unproven Kuna export stop", async () => {
  const unproven = unprovenCleanupLauncher("decompile-project");
  const fixture = await kunaSession(
    "rea-kuna-close-retry-mcp-",
    { project: "hang" },
    {},
    unproven.launcher,
  );
  const session = createTestBinarySession(fixture.provider);
  const server = createServer(
    { kind: "session", session },
    { logger: silentLogger },
  );
  const client = new Client({ name: "kuna-close-retry", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = (name: string, arguments_: Record<string, unknown> = {}) =>
    client.callTool({ name, arguments: arguments_ });
  const program = join(fixture.root, "program.elf");
  await writeFile(program, elfProgram());
  const targetBytes = await readFile(program);
  try {
    const opened = await call("open_binary", { path: program });
    expect(opened.isError, JSON.stringify(opened.content)).not.toBe(true);
    // The single-function answer returns while the project export stays live.
    const text = await call("procedure_pseudo_code", { procedure: "main" });
    expect(text.isError, JSON.stringify(text.content)).not.toBe(true);
    await expect.poll(() => exportsOf(fixture.kuna)).toHaveLength(1);

    const failed = parseMcpToolError(await call("close_binary"));
    expect(failed.error).toMatchObject({
      code: "cleanup_incomplete",
      retryable: false,
      recovery: { kind: "retry_cleanup", operation: "close_binary" },
      details: {
        provider_id: "kuna",
        operation: "close_binary",
        cleanup: "incomplete",
        diagnostics: { reason: "decompile-project stop unproven" },
      },
    });
    expect(failed.error.remediation.action).toBe(
      `Provider cleanup could not be fully confirmed. Review the reported local resources before opening another target. ${cleanupRetryRemediation({ operation: "close_binary" })}`,
    );
    expect(await sessionStatus(client)).toMatchObject({
      open: false,
      cleanup_pending: true,
    });
    // Reopening stays blocked; only close_binary offers its retry.
    const blocked = parseMcpToolError(
      await call("open_binary", { path: program }),
    );
    expect(blocked.error.code).toBe("cleanup_incomplete");
    expect(blocked.error).not.toHaveProperty("recovery");

    // A retry that still cannot prove the stop keeps the same conditional offer.
    const repeated = parseMcpToolError(await call("close_binary"));
    expect(repeated.error).toMatchObject({
      code: "cleanup_incomplete",
      recovery: { kind: "retry_cleanup", operation: "close_binary" },
    });

    unproven.release();
    const recovered = await call("close_binary");
    expect(recovered.isError, JSON.stringify(recovered.content)).not.toBe(true);
    expect(await sessionStatus(client)).toMatchObject({
      open: false,
      cleanup_pending: false,
    });
    expect(await readdir(join(fixture.cacheRoot, "staging"))).toEqual([]);
    expect(Buffer.compare(await readFile(program), targetBytes)).toBe(0);
  } finally {
    unproven.release();
    await client.close();
    await server.close();
    const closed = await session.close();
    if (!closed.ok) throw closed.error;
  }
});
