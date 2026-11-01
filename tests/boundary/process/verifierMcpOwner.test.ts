import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client, type Transport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import {
  createVerifierMcpOwner,
  VerifierStdioTransport,
} from "../../../scripts/lib/verifier-mcp-owner.mjs";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

it.each(["initialize", "discovery"])(
  "closes the real MCP child when %s fails before ownership transfers",
  async (mode) => {
    const workspace = await createTestTempDirectory("rea-verifier-mcp-owner-");
    const marker = join(workspace, "exit.txt");
    const client = new Client({ name: "verifier-owner-test", version: "1" });
    const transport = new VerifierStdioTransport({
      command: process.execPath,
      args: [
        fileURLToPath(
          new URL("../../fixtures/verifier-mcp-failure.mjs", import.meta.url),
        ),
      ],
      env: {
        PATH: process.env.PATH ?? "",
        REA_TEST_EXIT_MARKER: marker,
        REA_TEST_FAILURE_MODE: mode,
      },
      stderr: "pipe",
    });
    const owner = createVerifierMcpOwner();
    try {
      await expect(owner.open(client, transport)).rejects.toThrow();
      expect(await readFile(marker, "utf8")).toBe("exited");
    } finally {
      await owner.close();
    }
  },
);

it("retains an owner after failed cleanup and retries every close", async () => {
  const failure = new Error("discovery failed");
  const cleanupFailure = new Error("client close failed");
  let clientCloses = 0;
  let transportCloses = 0;
  const client = {
    connect: async () => {},
    listTools: async () => {
      throw failure;
    },
    close: async () => {
      if (++clientCloses === 1) throw cleanupFailure;
    },
  } as unknown as Client;
  const transport = {
    close: async () => {
      transportCloses++;
    },
  } as unknown as Transport;
  const owner = createVerifierMcpOwner();
  let thrown: unknown;
  try {
    await owner.open(client, transport);
  } catch (cause) {
    thrown = cause;
  }
  expect(thrown).toBeInstanceOf(AggregateError);
  expect((thrown as AggregateError).cause).toBe(failure);
  expect(transportCloses).toBe(1);
  await owner.close();
  expect(clientCloses).toBe(2);
  expect(transportCloses).toBe(2);
});
