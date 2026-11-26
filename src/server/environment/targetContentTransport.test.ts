import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";
import { describe, expect, it } from "vitest";

import { TARGET_CONTENT_RESULT_META } from "../toolResultEncoding.js";
import { TargetContentTransport } from "./targetContentTransport.js";

class StubTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly sent: JSONRPCMessage[] = [];

  async start(): Promise<void> {}
  async close(): Promise<void> {}
  async send(message: JSONRPCMessage): Promise<void> {
    this.sent.push(message);
  }
}

describe("TargetContentTransport", () => {
  it("refcounts overlapping tools/call request ids so every response retains target-content metadata", async () => {
    const inner = new StubTransport();
    const transport = new TargetContentTransport(inner);

    inner.onmessage?.({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "first", arguments: {} },
    });
    inner.onmessage?.({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: { name: "second", arguments: {} },
    });

    await transport.send({
      jsonrpc: "2.0",
      id: 5,
      result: { content: [{ type: "text", text: "one" }] },
    });
    await transport.send({
      jsonrpc: "2.0",
      id: 5,
      result: { content: [{ type: "text", text: "two" }] },
    });

    expect(inner.sent[0]).toMatchObject({
      id: 5,
      result: { _meta: TARGET_CONTENT_RESULT_META },
    });
    expect(inner.sent[1]).toMatchObject({
      id: 5,
      result: { _meta: TARGET_CONTENT_RESULT_META },
    });

    // Once both calls settle, an unrelated response with id 5 is not tagged.
    await transport.send({
      jsonrpc: "2.0",
      id: 5,
      result: { content: [{ type: "text", text: "extra" }] },
    });
    expect(inner.sent[2]).toEqual({
      jsonrpc: "2.0",
      id: 5,
      result: { content: [{ type: "text", text: "extra" }] },
    });
  });

  it("releases only one refcount per cancellation notification and ignores server requests", async () => {
    const inner = new StubTransport();
    const transport = new TargetContentTransport(inner);

    inner.onmessage?.({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "first", arguments: {} },
    });
    inner.onmessage?.({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "second", arguments: {} },
    });

    // A server-to-client request carrying id 7 must not consume pending tools/call state.
    await transport.send({
      jsonrpc: "2.0",
      id: 7,
      method: "roots/list",
    });

    inner.onmessage?.({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 7 },
    });

    await transport.send({
      jsonrpc: "2.0",
      id: 7,
      result: { content: [{ type: "text", text: "remaining" }] },
    });

    expect(inner.sent[1]).toMatchObject({
      id: 7,
      result: { _meta: TARGET_CONTENT_RESULT_META },
    });
  });

  it("clears refcounts on close() and closed()", async () => {
    const inner = new StubTransport();
    const transport = new TargetContentTransport(inner);

    inner.onmessage?.({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "held", arguments: {} },
    });
    await transport.close();

    await transport.send({
      jsonrpc: "2.0",
      id: 9,
      result: { content: [{ type: "text", text: "after close" }] },
    });
    expect(inner.sent[0]).toEqual({
      jsonrpc: "2.0",
      id: 9,
      result: { content: [{ type: "text", text: "after close" }] },
    });
  });
});
