import { createServer } from "node:net";
import { readFileSync } from "node:fs";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { CutterBridgeClient } from "../../../src/cutter/CutterBridgeClient.js";

const listen = async (
  server: ReturnType<typeof createServer>,
): Promise<number> => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected an ephemeral IPv4 listener");
  return address.port;
};

const statusServer = (
  token: string,
  currentFile: string | null,
  documentGeneration: number,
): ReturnType<typeof createServer> =>
  createServer((connection) => {
    connection.setEncoding("utf8");
    let requestText = "";
    connection.on("data", (chunk: string) => {
      requestText += chunk;
      const newline = requestText.indexOf("\n");
      if (newline < 0) return;
      const request = JSON.parse(requestText.slice(0, newline)) as Record<
        string,
        unknown
      >;
      connection.end(
        `${JSON.stringify({
          ok: request.token === token,
          session_id: request.session_id,
          current_file: currentFile,
          document_generation: documentGeneration,
          cutter_version: "Cutter fixture version",
          identity_status: "partial",
        })}\n`,
      );
    });
  });

const createStatusHarness = (
  token: string,
  currentFile: string | null,
  documentGeneration: number,
) => {
  let requestText = "";
  const server = statusServer(token, currentFile, documentGeneration);
  server.on("connection", (connection) => {
    connection.on("data", (chunk: Buffer) => {
      requestText += chunk.toString("utf8");
    });
  });
  return { server, requestText: () => requestText };
};

const writeDescriptor = async (
  directory: string,
  sessionId: string,
  port: number,
  token: string,
  currentFile: string | null = null,
  documentGeneration = 0,
): Promise<void> =>
  writeFile(
    join(directory, `cutter-${process.pid}-${sessionId}.json`),
    JSON.stringify({
      session_id: sessionId,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      token,
      document_generation: documentGeneration,
      current_file: currentFile,
      cutter_version: "Cutter fixture version",
      identity_status: "partial",
    }),
    { mode: 0o600 },
  );

const expectDiscoveredSession = (
  result: unknown,
  sessionId: string,
  documentGeneration: number,
  currentFile: string,
): void => {
  expect(result).toMatchObject({
    discovery_status: "sessions_found",
    bridge_directory_security: "private_verified",
    sessions: [
      {
        session_id: sessionId,
        document_generation: documentGeneration,
        current_file: currentFile,
        cutter_version: "Cutter fixture version",
      },
    ],
  });
};

const createClient = (environment: NodeJS.ProcessEnv): CutterBridgeClient => {
  if (process.platform !== "win32") return new CutterBridgeClient(environment);
  return new CutterBridgeClient(environment, {
    windowsPrivateReader: {
      verifyDirectory: () => true,
      readDescriptor: (root, name, maxBytes) => {
        const bytes = readFileSync(join(root, name));
        if (bytes.byteLength > maxBytes)
          throw new Error("Descriptor too large");
        return bytes;
      },
    },
  });
};

const verifyCutterCancellationAfterDispatch = async (): Promise<void> => {
  const directory = await mkdtemp(join(tmpdir(), "rea-cutter-cancel-test-"));
  const sessionId = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
  const token = "synthetic-cutter-bridge-token-for-test";
  let markDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    markDispatched = resolve;
  });
  const server = createServer((connection) => {
    connection.once("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString("utf8")) as {
        kind?: string;
      };
      expect(request.kind).toBe("command");
      markDispatched?.();
    });
  });
  try {
    const port = await listen(server);
    await writeDescriptor(directory, sessionId, port, token);
    const controller = new AbortController();
    const execution = createClient({
      REA_CUTTER_BRIDGE_DIR: directory,
    }).execute({
      sessionId,
      expectedGeneration: 0,
      command: "Ps /tmp/possibly-saved.rzdb",
      json: false,
      signal: controller.signal,
    });
    await dispatched;
    controller.abort();
    await expect(execution).resolves.toMatchObject({
      executionState: "unknown",
      error: "transport-response-missing",
      message: expect.stringContaining("do not retry automatically"),
      documentGeneration: 0,
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
};

describe("CutterBridgeClient", () => {
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

  it("discovers a live bridge using the exact session ID from its descriptor", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-bridge-test-"));
    const sessionId = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
    const token = "synthetic-cutter-bridge-token-for-test";
    const harness = createStatusHarness(token, "/tmp/sample.bin", 4);
    server = harness.server;
    const port = await listen(server);
    await writeDescriptor(directory, sessionId, port, token);

    const result = await createClient({
      REA_CUTTER_BRIDGE_DIR: directory,
    }).listSessions();

    expectDiscoveredSession(result, sessionId, 4, "/tmp/sample.bin");
    expect(JSON.parse(harness.requestText())).toMatchObject({
      kind: "status",
      session_id: sessionId,
    });
  });

  it("rejects a POSIX bridge directory that is accessible to other users", async () => {
    if (process.platform === "win32") return;
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-insecure-"));
    await chmod(directory, 0o755);

    const result = await new CutterBridgeClient({
      REA_CUTTER_BRIDGE_DIR: directory,
    }).listSessions();

    expect(result).toMatchObject({
      sessions: [],
      discovery_status: "bridge_directory_insecure",
      bridge_directory_security: "not_private",
    });
  });

  it("preserves unknown execution state when a live bridge closes after command dispatch", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-close-test-"));
    const sessionId = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
    server = createServer((connection) =>
      connection.on("data", () => connection.destroy()),
    );
    const port = await listen(server);
    await writeDescriptor(
      directory,
      sessionId,
      port,
      "synthetic-cutter-bridge-token-for-test",
    );

    await expect(
      createClient({ REA_CUTTER_BRIDGE_DIR: directory }).execute({
        sessionId,
        expectedGeneration: 0,
        command: "Ps /tmp/possibly-saved.rzdb",
        json: false,
      }),
    ).resolves.toMatchObject({
      executionState: "unknown",
      error: "transport-response-missing",
      message: expect.stringContaining("do not retry automatically"),
      documentGeneration: 0,
    });
  });
  it(
    "reports unknown completion when cancellation follows Cutter command dispatch",
    verifyCutterCancellationAfterDispatch,
  );
  it("uses verified Windows handle reads before trusting Cutter descriptors", async () => {
    directory = await mkdtemp(
      join(tmpdir(), "rea-cutter-windows-bridge-test-"),
    );
    const sessionId = "27d3e3f1-f1e5-49ae-91ec-95af1f343a5a";
    const token = "synthetic-cutter-bridge-token-for-test";
    server = statusServer(token, "C:\\fixtures\\sample.exe", 1);
    const port = await listen(server);
    const entry = `cutter-${process.pid}-${sessionId}.json`;
    const descriptor = {
      session_id: sessionId,
      pid: process.pid,
      host: "127.0.0.1",
      port,
      token,
      document_generation: 0,
      current_file: null,
      cutter_version: "Cutter fixture version",
      identity_status: "partial",
    };
    await writeFile(
      join(directory, entry),
      "native reader owns descriptor bytes",
    );
    let reads = 0;
    const result = await new CutterBridgeClient(
      { REA_CUTTER_BRIDGE_DIR: directory },
      {
        platform: "win32",
        windowsPrivateReader: {
          verifyDirectory: () => true,
          readDescriptor: (root, name, maxBytes) => {
            expect(root).toBe(directory);
            expect(name).toBe(entry);
            expect(maxBytes).toBe(64 * 1024);
            reads += 1;
            return Buffer.from(JSON.stringify(descriptor));
          },
        },
      },
    ).listSessions();

    expect(reads).toBe(1);
    expectDiscoveredSession(result, sessionId, 1, "C:\\fixtures\\sample.exe");
  });

  it("fails closed when Windows ACL verification is unavailable", async () => {
    directory = await mkdtemp(join(tmpdir(), "rea-cutter-windows-insecure-"));

    const result = await new CutterBridgeClient(
      { REA_CUTTER_BRIDGE_DIR: directory },
      {
        platform: "win32",
        windowsPrivateReader: {
          verifyDirectory: () => false,
          readDescriptor: () => Buffer.from("{}"),
        },
      },
    ).listSessions();

    expect(result).toMatchObject({
      sessions: [],
      discovery_status: "bridge_directory_insecure",
      bridge_directory_security: "not_private",
    });
  });
});
