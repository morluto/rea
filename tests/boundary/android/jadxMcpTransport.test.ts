import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import {
  serializeMessage,
  type JSONRPCMessage,
} from "@modelcontextprotocol/client";
import { expect, it } from "vitest";
import type { ProviderProcessHandle } from "../../../src/process/ProviderProcess.js";
import { JadxMcpTransport, type JadxLauncher } from "../../../src/android/JadxMcpTransport.js";

class FixtureProcess extends EventEmitter implements ProviderProcessHandle {
  readonly pid = 1;
  readonly stdout = new PassThrough();
  readonly stdin = new PassThrough();
  readonly stderr = new PassThrough();
  readonly exitCode = null;
  readonly signalCode = null;

  kill(): boolean {
    return true;
  }
}

it("decodes split UTF-8 and newline bytes, then routes multiple complete frames", async () => {
  const process = new FixtureProcess();
  const launcher: JadxLauncher = async ({ runId }) => ({
    process,
    ownership: {
      runId,
      leaderPid: process.pid,
      processGroupId: process.pid,
      expectedParentPid: process.pid,
    },
    cleanup: async () => {
      process.emit("exit", 0, null);
      process.emit("close", 0, null);
      process.stdout.end();
      process.stderr.end();
      process.stdin.end();
      return { cleaned: true, signaled: false };
    },
  });
  const transport = new JadxMcpTransport(
    { command: "fixture", arguments: [] },
    launcher,
  );
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (message) => received.push(message);

  await transport.start();
  const first = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "snow 雪 🦊" }] },
  } satisfies JSONRPCMessage;
  const second = {
    jsonrpc: "2.0",
    id: 2,
    result: { content: [{ type: "text", text: "second" }] },
  } satisfies JSONRPCMessage;
  const third = {
    jsonrpc: "2.0",
    id: 3,
    result: { content: [{ type: "text", text: "third" }] },
  } satisfies JSONRPCMessage;
  for (const byte of Buffer.from(serializeMessage(first)))
    process.stdout.write(Buffer.from([byte]));
  process.stdout.write(
    Buffer.from(serializeMessage(second) + serializeMessage(third)),
  );

  expect(received).toEqual([first, second, third]);
  await transport.close();
});

it("accepts a complete JSON-RPC frame at the 8 MiB boundary", async () => {
  const process = new FixtureProcess();
  const launcher: JadxLauncher = async ({ runId }) => ({
    process,
    ownership: {
      runId,
      leaderPid: process.pid,
      processGroupId: process.pid,
      expectedParentPid: process.pid,
    },
    cleanup: async () => {
      process.emit("exit", 0, null);
      process.emit("close", 0, null);
      process.stdout.end();
      process.stderr.end();
      process.stdin.end();
      return { cleaned: true, signaled: false };
    },
  });
  const transport = new JadxMcpTransport(
    { command: "fixture", arguments: [] },
    launcher,
  );
  const received: JSONRPCMessage[] = [];
  transport.onmessage = (message) => received.push(message);
  const response = {
    jsonrpc: "2.0",
    id: 1,
    result: { content: [{ type: "text", text: "" }] },
  } satisfies JSONRPCMessage;
  const emptyFrameBytes = Buffer.byteLength(serializeMessage(response)) - 1;
  const maxFrameResponse = {
    ...response,
    result: {
      content: [
        { type: "text", text: "x".repeat(8 * 1024 * 1024 - emptyFrameBytes) },
      ],
    },
  } satisfies JSONRPCMessage;
  const frame = Buffer.from(serializeMessage(maxFrameResponse));

  expect(frame.at(-1)).toBe(10);
  expect(frame.length - 1).toBe(8 * 1024 * 1024);
  await transport.start();
  process.stdout.write(frame);

  expect(received).toEqual([maxFrameResponse]);
  await transport.close();
});
