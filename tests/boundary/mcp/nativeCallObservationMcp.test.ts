import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import { z } from "zod";

import { nativeCallObservationResultSchema } from "../../../src/domain/native/nativeCallObservation.js";
import { ok } from "../../../src/domain/result.js";
import type { NativeCallTracer } from "../../../src/native/LldbCallTracer.js";
import { NativeMacOSProvider } from "../../../src/native/NativeMacOSProvider.js";
import { createServer } from "../../../src/server/createServer.js";
import { createTestBinarySession } from "../../fixtures/binarySession.js";
import { NativeFixtureRunner } from "../../fixtures/nativeCommands.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";

/** A thin little-endian arm64 MH_EXECUTE header with no load commands. */
const machoHeader = (): Buffer => {
  const header = Buffer.alloc(32);
  header.writeUInt32LE(0xfeedfacf, 0);
  header.writeUInt32LE(0x0100000c, 4);
  header.writeUInt32LE(2, 12);
  return header;
};

const tracer: NativeCallTracer & { calls: number } = {
  calls: 0,
  trace(request) {
    this.calls++;
    return Promise.resolve(
      ok({
        debugger: {
          path: "/usr/bin/lldb",
          sha256: "b".repeat(64),
          version: "lldb-fixture",
        },
        run: {
          status: "traced",
          version: "lldb-fixture",
          pid: 99,
          outcome: "exited",
          exit_status: 0,
          exit_description: null,
          killed: false,
          terminated: true,
          target_identity: {
            loaded_image_sha256: null,
            selected_file_sha256: request.expectedSha256,
            file_device: "1",
            file_inode: "2",
            module_path: request.executable,
            module_uuid: "fixture-uuid",
            stable: true,
          },
          elapsed_ms: 1,
          breakpoints: request.input.breakpoints.map((_, index) => ({
            index,
            location_count: 1,
            locations: [],
          })),
          events: [],
          resource_limit_reached: false,
          target_output: {
            stdout_bytes: 0,
            stderr_bytes: 0,
            stdout_truncated: false,
            stderr_truncated: false,
            stdout_complete: true,
            stderr_complete: true,
          },
          other_stops: [],
        },
        stdout: { text: "", bytes: 0, truncated: false, complete: true },
        stderr: { text: "", bytes: 0, truncated: false, complete: true },
        terminated: true,
      }),
    );
  },
};

it("routes observe_native_calls through MCP with schema-checked input and output", async () => {
  const directory = await createTestTempDirectory("rea-native-calls-mcp-");
  const path = join(directory, "Tool");
  await writeFile(path, machoHeader());
  const session = createTestBinarySession(
    new NativeMacOSProvider(new NativeFixtureRunner(), "darwin", tracer),
  );
  const server = createServer(session, session);
  const client = new Client({ name: "native-calls-mcp-test", version: "1" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const opened = await client.callTool({
      name: "open_binary",
      arguments: { path },
    });
    expect(opened.isError, JSON.stringify(opened)).not.toBe(true);
    const called = await client.callTool({
      name: "observe_native_calls",
      arguments: {
        breakpoints: [{ kind: "function", name: "open" }],
        duration_ms: 1000,
      },
    });
    expect(called.isError, JSON.stringify(called.structuredContent)).not.toBe(
      true,
    );
    const result = nativeCallObservationResultSchema.parse(
      z.object({ result: z.unknown() }).parse(called.structuredContent).result,
    );
    expect(result.process).toMatchObject({ pid: 99, outcome: "exited" });
    expect(result.breakpoints[0]?.request).toEqual({
      kind: "function",
      name: "open",
      module: null,
    });
    const rejected = await client.callTool({
      name: "observe_native_calls",
      arguments: {
        breakpoints: [{ kind: "function", name: "open" }],
        duration_ms: 1,
      },
    });
    expect(rejected.isError).toBe(true);
    expect(tracer.calls).toBe(1);
  } finally {
    await client.close();
    await server.close();
  }
});
