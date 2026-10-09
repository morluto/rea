import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, expect, it } from "vitest";

import { CutterBridgeClient } from "../../../src/cutter/CutterBridgeClient.js";

const SESSION_ID = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
const TOKEN = "synthetic-cutter-bridge-token-for-test";
let directory: string | undefined;
let server: ReturnType<typeof createServer> | undefined;

afterEach(async () => {
  if (server !== undefined)
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  if (directory !== undefined)
    await rm(directory, { recursive: true, force: true });
  server = undefined;
  directory = undefined;
});

const listen = async (
  listener: ReturnType<typeof createServer>,
): Promise<number> => {
  await new Promise<void>((resolve) =>
    listener.listen(0, "127.0.0.1", resolve),
  );
  const address = listener.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral IPv4 listener");
  return address.port;
};

const statusServer = (
  currentFile: string | null,
  documentGeneration: number,
): ReturnType<typeof createServer> =>
  createServer((connection) => {
    connection.setEncoding("utf8");
    let input = "";
    connection.on("data", (chunk: string) => {
      input += chunk;
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(input.slice(0, newline)) as Record<
        string,
        unknown
      >;
      connection.end(
        `${JSON.stringify({
          ok: request.token === TOKEN,
          session_id: request.session_id,
          current_file: currentFile,
          document_generation: documentGeneration,
          cutter_version: "Cutter fixture version",
          identity_status: "partial",
        })}\n`,
      );
    });
  });

const clientFor = (bridgeDirectory: string): CutterBridgeClient =>
  process.platform === "win32"
    ? new CutterBridgeClient(
        { REA_CUTTER_BRIDGE_DIR: bridgeDirectory },
        {
          windowsPrivateReader: {
            verifyDirectory: () => true,
            readDescriptor: (root, name, maxBytes) => {
              const bytes = readFileSync(join(root, name));
              if (bytes.byteLength > maxBytes)
                throw new Error("Descriptor too large");
              return bytes;
            },
          },
        },
      )
    : new CutterBridgeClient({ REA_CUTTER_BRIDGE_DIR: bridgeDirectory });

const writeDescriptor = async (port: number): Promise<void> => {
  if (directory === undefined) throw new Error("Test directory is unavailable");
  await writeFile(
    join(directory, `cutter-${process.pid}-${SESSION_ID}.json`),
    JSON.stringify({
      session_id: SESSION_ID,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      token: TOKEN,
      document_generation: 1,
      current_file: "/old/sample.bin",
      cutter_version: "Cutter fixture version",
      identity_status: "partial",
    }),
    { mode: 0o600 },
  );
};

it("preserves a live Cutter status that explicitly has no active document", async () => {
  directory = await mkdtemp(join(tmpdir(), "rea-cutter-null-status-"));
  server = statusServer(null, 2);
  await writeDescriptor(await listen(server));

  const result = await clientFor(directory).listSessions();

  expect(result.sessions[0]).toMatchObject({
    session_id: SESSION_ID,
    document_generation: 2,
    current_file: null,
  });
});

it("preserves a null active document returned after a Cutter command", async () => {
  directory = await mkdtemp(join(tmpdir(), "rea-cutter-null-command-"));
  server = statusServer(null, 2);
  await writeDescriptor(await listen(server));

  const result = await clientFor(directory).execute({
    sessionId: SESSION_ID,
    expectedGeneration: 2,
    command: "ij",
    json: true,
  });

  expect(result.currentFile).toBeNull();
});
