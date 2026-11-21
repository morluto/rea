import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it, vi } from "vitest";

import { connectLocalToolsMcp } from "../fixtures/localToolsMcp.js";

it("attempts transport cleanup after a rejected client close and keeps cleanup retryable", async () => {
  const failure = new Error("client close failed");
  const connect = vi.spyOn(Client.prototype, "connect").mockResolvedValue();
  const list = vi
    .spyOn(Client.prototype, "listTools")
    .mockResolvedValue({ tools: [] });
  const closeClient = vi
    .spyOn(Client.prototype, "close")
    .mockRejectedValueOnce(failure)
    .mockResolvedValue();
  const closeTransport = vi
    .spyOn(StdioClientTransport.prototype, "close")
    .mockResolvedValue();
  let cleanup: (() => Promise<void>) | undefined;
  try {
    await connectLocalToolsMcp({}, (close) => {
      cleanup = close;
    });
    if (cleanup === undefined) throw new Error("Missing registered cleanup");
    const rejected = await cleanup().catch((cause: unknown) => cause);
    expect(closeTransport).toHaveBeenCalledTimes(1);
    expect(rejected).toMatchObject({ errors: [failure] });
    await expect(cleanup()).resolves.toBeUndefined();
    expect(closeClient).toHaveBeenCalledTimes(2);
    expect(closeTransport).toHaveBeenCalledTimes(2);
  } finally {
    connect.mockRestore();
    list.mockRestore();
    closeClient.mockRestore();
    closeTransport.mockRestore();
  }
});
