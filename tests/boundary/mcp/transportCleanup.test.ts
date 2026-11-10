import { expect, it, vi } from "vitest";
import { JadxProvider } from "../../../src/android/JadxProvider.js";
import { createManagedBinarySession } from "../../../src/composition/binary.js";
import { silentLogger } from "../../../src/logger.js";
import { startMcpTransport } from "../../../src/main/transport.js";
import { createServer } from "../../../src/server/createServer.js";
import { createToolResultDelivery } from "../../../src/server/toolResult.js";

const startOneServer = (
  session: Parameters<typeof startMcpTransport>[1],
  construct: typeof createServer,
) =>
  startMcpTransport(
    {
      env: {},
      serve: async (factory) => {
        await factory({ era: "modern" });
        return { close: async () => undefined };
      },
      createServer: construct,
      writeStderr: () => undefined,
      setExitCode: () => undefined,
      registerShutdown: () => () => undefined,
    },
    session,
    {
      logger: silentLogger,
      serverLogger: silentLogger,
      environment: {},
      delivery: createToolResultDelivery(undefined),
      loadOptionalProviders: async () => ({}),
    },
  );

it("preserves Android sibling cleanup failures and retries only unfinished owners", async () => {
  const session = createManagedBinarySession();
  const failures = [
    new Error("first Android cleanup"),
    new Error("second Android cleanup"),
  ];
  const closes: ReturnType<typeof vi.spyOn>[] = [];
  let fail = true;
  const transport = await startMcpTransport(
    {
      env: {},
      serve: async (factory) => {
        // The SDK can create a discovery probe followed by replacement servers.
        await factory({ era: "modern" });
        await factory({ era: "legacy" });
        await factory({ era: "modern" });
        return { close: async () => undefined };
      },
      createServer: (source, options) => {
        const provider = options?.androidAnalysis;
        if (provider === undefined)
          throw new Error("Missing owned Android provider");
        const failure = failures[closes.length];
        closes.push(
          vi.spyOn(provider, "close").mockImplementation(async () => {
            if (fail && failure !== undefined) throw failure;
          }),
        );
        return createServer(source, options);
      },
      writeStderr: () => undefined,
      setExitCode: () => undefined,
      registerShutdown: () => () => undefined,
    },
    session,
    {
      logger: silentLogger,
      serverLogger: silentLogger,
      environment: {},
      delivery: createToolResultDelivery(undefined),
      loadOptionalProviders: async () => ({}),
    },
  );
  try {
    expect(transport.ok).toBe(true);
    await expect(transport.closeAndroid()).rejects.toMatchObject({
      name: "AggregateError",
      errors: failures,
    });
    expect(closes.map((close) => close.mock.calls.length)).toEqual([1, 1, 1]);
    // One recovered owner leaves the exact remaining failure available.
    closes[0]?.mockResolvedValue(undefined);
    await expect(transport.closeAndroid()).rejects.toBe(failures[1]);
    expect(closes.map((close) => close.mock.calls.length)).toEqual([2, 2, 1]);
    fail = false;
    await transport.closeAndroid();
    await transport.closeAndroid();
    expect(closes.map((close) => close.mock.calls.length)).toEqual([2, 3, 1]);
  } finally {
    fail = false;
    for (const close of closes) close.mockRestore();
    await transport.handle.close();
    await transport.closeAndroid();
    await transport.closeOptionalProviders();
    await session.close();
  }
});

it("releases the Android fallback when its actual server owner closes successfully", async () => {
  const session = createManagedBinarySession();
  const underlyingClose = vi.spyOn(JadxProvider.prototype, "close");
  let server: ReturnType<typeof createServer> | undefined;
  const transport = await startOneServer(session, (source, options) => {
    server = createServer(source, options);
    return server;
  });
  try {
    expect(transport.ok).toBe(true);
    if (server === undefined)
      throw new Error("Expected a constructed SDK server");
    await server.close();
    expect(underlyingClose).toHaveBeenCalledTimes(1);
    await transport.closeAndroid();
    await transport.closeAndroid();
    expect(underlyingClose).toHaveBeenCalledTimes(1);
  } finally {
    await transport.handle.close();
    await transport.closeAndroid();
    await transport.closeOptionalProviders();
    await session.close();
    underlyingClose.mockRestore();
  }
});

it.each(["server close", "server construction"] as const)(
  "keeps the Android fallback after failed %s until the exact provider closes",
  async (stage) => {
    const session = createManagedBinarySession();
    const failure = new Error("Controlled first Android cleanup refusal");
    const underlyingClose = vi
      .spyOn(JadxProvider.prototype, "close")
      .mockRejectedValueOnce(failure);
    let server: ReturnType<typeof createServer> | undefined;
    const transport = await startOneServer(session, (source, options) => {
      if (stage === "server construction")
        throw new Error("Controlled server construction failure");
      server = createServer(source, options);
      return server;
    });
    try {
      expect(transport.ok).toBe(stage === "server close");
      if (stage === "server close") {
        if (server === undefined)
          throw new Error("Expected a constructed SDK server");
        await expect(server.close()).rejects.toMatchObject({
          name: "AggregateError",
          errors: [{ name: "AggregateError", errors: [failure] }],
        });
      }
      // Failed construction also attempts cleanup before returning its partial
      // owner. Both paths must preserve the same failed provider for fallback.
      expect(underlyingClose).toHaveBeenCalledTimes(1);
      await transport.closeAndroid();
      expect(underlyingClose).toHaveBeenCalledTimes(2);
      await transport.closeAndroid();
      expect(underlyingClose).toHaveBeenCalledTimes(2);
    } finally {
      await transport.handle.close();
      await transport.closeAndroid();
      await transport.closeOptionalProviders();
      await session.close();
      underlyingClose.mockRestore();
    }
  },
);
