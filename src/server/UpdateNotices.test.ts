import { afterEach, expect, it, vi } from "vitest";
import {
  Client,
  InMemoryTransport,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { z } from "zod";

import { ok, err } from "../domain/result.js";
import { EvidenceMcpServerCore } from "./EvidenceMcpServerCore.js";
import { ToolResultDelivery } from "./ToolResultDelivery.js";
import {
  configuredUpdateNoticeFactory,
  lookupLatestRelease,
  UpdateNotices,
} from "./UpdateNotices.js";

import { serveStreamableHttp } from "./http/serveStreamableHttp.js";
import { TARGET_CONTENT_RESULT_META } from "./toolResultEncoding.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("keeps networking opt-in", () => {
  expect(configuredUpdateNoticeFactory({})).toBeUndefined();
  expect(
    configuredUpdateNoticeFactory({ REA_MCP_UPDATE_CHECK: "0" }),
  ).toBeUndefined();
  expect(
    configuredUpdateNoticeFactory({ REA_MCP_UPDATE_CHECK: "typo" }),
  ).toBeUndefined();
  const factory = configuredUpdateNoticeFactory({ REA_MCP_UPDATE_CHECK: "1" });
  expect(factory?.()).toBeInstanceOf(UpdateNotices);
  expect(factory?.()).not.toBe(factory?.());
});

const receivedNotices = new WeakMap<Client, unknown[]>();
const createClient = () => {
  const client = new Client({ name: "update-test", version: "1" });
  const notices: unknown[] = [];
  client.setNotificationHandler("notifications/message", (message) => {
    notices.push(message.params);
  });
  receivedNotices.set(client, notices);
  return client;
};

const createFixtureServer = (factory: () => UpdateNotices, budget = 16384) => {
  const server = new EvidenceMcpServerCore(
    { name: "update-test", version: "1" },
    { capabilities: {} },
    undefined,
    new ToolResultDelivery(budget),
  );
  server.updateNoticeFactory = factory;
  server.registerTool(
    "fixture",
    {
      inputSchema: z.strictObject({ fail: z.boolean().optional() }),
      outputSchema: z.strictObject({ result: z.number() }),
    },
    async ({ fail }) =>
      fail
        ? { isError: true, content: [{ type: "text", text: "failure" }] }
        : {
            content: [{ type: "text", text: '{"result":42}' }],
            structuredContent: { result: 42 },
            _meta: { ...TARGET_CONTENT_RESULT_META, retained: "fixture" },
          },
  );
  return server;
};

const connect = async (notices: UpdateNotices, budget = 16384) => {
  const server = createFixtureServer(() => notices, budget);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = createClient();
  await client.connect(clientTransport);
  cleanups.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
};

it("does not block a tool or discovery, preserves structured output and announces once", async () => {
  let release!: (value: ReturnType<typeof ok<string>>) => void;
  const lookup = vi.fn(
    () =>
      new Promise<ReturnType<typeof ok<string>>>((resolve) => {
        release = resolve;
      }),
  );
  const client = await connect(new UpdateNotices("1.0.0", lookup));
  await client.listTools();
  expect(lookup).not.toHaveBeenCalled();
  const first = await client.callTool({ name: "fixture", arguments: {} });
  expect(first.structuredContent).toEqual({ result: 42 });
  expect(first.content).toHaveLength(1);
  release(ok("1.1.0"));
  await vi.waitFor(() => expect(lookup).toHaveResolved());
  const second = await client.callTool({ name: "fixture", arguments: {} });
  expect(second.structuredContent).toEqual(first.structuredContent);
  expect(second).toEqual(first);
  expect(second._meta).toEqual({
    ...TARGET_CONTENT_RESULT_META,
    retained: "fixture",
  });
  expect(receivedNotices.get(client)).toEqual([
    {
      level: "notice",
      logger: "rea.update",
      data: expect.stringContaining("latest published 1.1.0"),
    },
  ]);
  const third = await client.callTool({ name: "fixture", arguments: {} });
  expect(third).toEqual(first);
  expect(lookup).toHaveBeenCalledTimes(1);
  expect(receivedNotices.get(client)).toHaveLength(1);
});

it("leaves errors unchanged and retains notices when the receive budget is full", async () => {
  const notices = new UpdateNotices("1.0.0", async () => ok("1.1.0"));
  notices.refresh();
  await vi.waitFor(() => expect(notices.peek()).toBeDefined());
  const client = await connect(notices, 256);
  const failed = await client.callTool({
    name: "fixture",
    arguments: { fail: true },
  });
  expect(failed.isError).toBe(true);
  const baseline = await connect(
    new UpdateNotices("1.0.0", async () => ok("1.0.0")),
    256,
  );
  expect(failed).toEqual(
    await baseline.callTool({ name: "fixture", arguments: { fail: true } }),
  );
  const success = await client.callTool({ name: "fixture", arguments: {} });
  expect(success.content).toHaveLength(1);
  expect(success.structuredContent).toEqual({ result: 42 });
  expect(notices.peek()).toBeDefined();
  expect(receivedNotices.get(client)).toHaveLength(0);
});

it("backs off failures for 24 hours, retries on demand, and ignores malformed or older versions", async () => {
  let now = 0;
  const lookup = vi
    .fn()
    .mockResolvedValueOnce(err("unavailable"))
    .mockResolvedValueOnce(ok("invalid"))
    .mockResolvedValueOnce(ok("0.9.0"))
    .mockResolvedValueOnce(ok("1.1.0"));
  const notices = new UpdateNotices("1.0.0", lookup, () => now);
  for (let i = 0; i < 4; i++) {
    notices.refresh();
    await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(i + 1));
    expect(notices.peek() === undefined).toBe(i < 3);
    notices.refresh();
    expect(lookup).toHaveBeenCalledTimes(i + 1);
    now += 24 * 60 * 60 * 1000;
  }
  await notices.close();
});

it("cancels and joins pending discovery at close, suppressing late success", async () => {
  let signal: AbortSignal | undefined;
  let release!: () => void;
  const notices = new UpdateNotices("1.0.0", async (selected) => {
    signal = selected;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return ok("1.1.0");
  });
  notices.refresh();
  await vi.waitFor(() => expect(signal).toBeDefined());
  let closed = false;
  const closing = notices.close().then(() => {
    closed = true;
  });
  expect(signal?.aborted).toBe(true);
  expect(closed).toBe(false);
  release();
  await closing;
  expect(notices.peek()).toBeUndefined();
  notices.refresh();
  expect(closed).toBe(true);
});

it.each([
  ['{"latest":"1.1.0"}', true],
  ['{"latest":"malformed"}', false],
  ["not json", false],
  [" ".repeat(16385), false],
])("bounds and validates public dist-tags case %#", async (body, success) => {
  const fetching = vi.fn(async () => new Response(body));
  vi.stubGlobal("fetch", fetching);
  expect((await lookupLatestRelease(new AbortController().signal)).ok).toBe(
    success,
  );
  expect(fetching).toHaveBeenCalledWith(
    expect.stringContaining("/-/package/rea-agents/dist-tags"),
    expect.objectContaining({ redirect: "error" }),
  );
});

it("shares one lookup and one notice across concurrent requests", async () => {
  const lookup = vi.fn(async () => ok("1.1.0"));
  const notices = new UpdateNotices("1.0.0", lookup);
  notices.refresh();
  await vi.waitFor(() => expect(notices.peek()).toBeDefined());
  const client = await connect(notices);
  const replies = await Promise.all(
    Array.from({ length: 8 }, () =>
      client.callTool({ name: "fixture", arguments: {} }),
    ),
  );
  expect(replies.every((reply) => reply.content.length === 1)).toBe(true);
  expect(receivedNotices.get(client)).toHaveLength(1);
  expect(
    replies.every(
      (reply) => JSON.stringify(reply.structuredContent) === '{"result":42}',
    ),
  ).toBe(true);
  expect(lookup).toHaveBeenCalledTimes(1);
});

it("aborts stalled lookups at the deadline without failing analysis", async () => {
  vi.useFakeTimers();
  const lookup = vi.fn(
    (signal: AbortSignal) =>
      new Promise<ReturnType<typeof err<"unavailable">>>((resolve) => {
        signal.addEventListener("abort", () => resolve(err("unavailable")), {
          once: true,
        });
      }),
  );
  const notices = new UpdateNotices("1.0.0", lookup);
  notices.refresh();
  await vi.advanceTimersByTimeAsync(5000);
  expect(lookup.mock.calls[0]?.[0].aborted).toBe(true);
  expect(notices.peek()).toBeUndefined();
  notices.refresh();
  expect(lookup).toHaveBeenCalledTimes(1);
  await notices.close();
});

it("treats HTTP failure and network rejection as unavailable metadata", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response("denied", { status: 403 }))
      .mockRejectedValueOnce(new Error("offline")),
  );
  const signal = new AbortController().signal;
  expect(await lookupLatestRelease(signal)).toEqual(err("unavailable"));
  expect(await lookupLatestRelease(signal)).toEqual(err("unavailable"));
});

it("server shutdown owns pending lookups even without a remaining SDK transport", async () => {
  let release!: () => void;
  let signal: AbortSignal | undefined;
  const notices = new UpdateNotices("1.0.0", async (selected) => {
    signal = selected;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return ok("1.1.0");
  });
  const server = new EvidenceMcpServerCore(
    { name: "closed-transport", version: "1" },
    {},
    undefined,
    new ToolResultDelivery(16384),
  );
  server.updateNoticeFactory = () => notices;
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  notices.refresh();
  await vi.waitFor(() => expect(signal).toBeDefined());
  await clientTransport.close();
  let closed = false;
  const closing = server.close().then(() => {
    closed = true;
  });
  expect(signal?.aborted).toBe(true);
  expect(closed).toBe(false);
  release();
  await closing;
  expect(closed).toBe(true);
  expect(notices.peek()).toBeUndefined();
});

it.each(["DELETE", "replacement"])(
  "announces again after HTTP session %s on the same listener",
  async (ending) => {
    const lookup = vi.fn(async () => ok("1.1.0"));
    const factory = vi.fn(() => new UpdateNotices("1.0.0", lookup));
    const server = createFixtureServer(factory);
    const served = await serveStreamableHttp({
      host: "127.0.0.1",
      port: 0,
      createMcpServer: () => server,
    });
    cleanups.push(() => served.close());
    const open = async () => {
      const client = createClient();
      const transport = new StreamableHTTPClientTransport(new URL(served.url));
      cleanups.push(() => client.close());
      await client.connect(transport);
      return { client, transport };
    };
    const announce = async (client: Client, count: number) => {
      const first = await client.callTool({ name: "fixture", arguments: {} });
      await vi.waitFor(() => expect(lookup).toHaveBeenCalledTimes(count));
      await vi.waitFor(async () => {
        const next = await client.callTool({ name: "fixture", arguments: {} });
        expect(next).toEqual(first);
        expect(receivedNotices.get(client)).toHaveLength(1);
      });
      expect(receivedNotices.get(client)).toEqual([
        {
          level: "notice",
          logger: "rea.update",
          data: expect.stringContaining("latest published 1.1.0"),
        },
      ]);
    };
    const first = await open();
    await announce(first.client, 1);
    if (ending === "DELETE") await first.transport.terminateSession();
    const second = await open();
    await announce(second.client, 2);
    expect(factory).toHaveBeenCalledTimes(2);
  },
);

it("honors the client's logging threshold and does not retry filtered notices", async () => {
  const notices = new UpdateNotices("1.0.0", async () => ok("1.1.0"));
  notices.refresh();
  await vi.waitFor(() => expect(notices.peek()).toBeDefined());
  const client = await connect(notices);
  await client.setLoggingLevel("error");
  const first = await client.callTool({ name: "fixture", arguments: {} });
  expect(receivedNotices.get(client)).toHaveLength(0);
  expect(notices.peek()).toBeUndefined();
  await client.setLoggingLevel("notice");
  expect(await client.callTool({ name: "fixture", arguments: {} })).toEqual(
    first,
  );
  expect(receivedNotices.get(client)).toHaveLength(0);
});

it.each(["reject", "throw", "pending"])(
  "keeps analysis working when advisory delivery is %s and never retries uncertain delivery",
  async (failure) => {
    const notices = new UpdateNotices("1.0.0", async () => ok("1.1.0"));
    notices.refresh();
    await vi.waitFor(() => expect(notices.peek()).toBeDefined());
    const server = createFixtureServer(() => notices);
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    const original = serverTransport.send.bind(serverTransport);
    let attempts = 0;
    const sending = vi
      .spyOn(serverTransport, "send")
      .mockImplementation((message, options) => {
        if ("method" in message && message.method === "notifications/message") {
          attempts++;
          if (failure === "throw") throw new Error("advisory failure");
          return failure === "reject"
            ? Promise.reject(new Error("advisory failure"))
            : new Promise<void>(() => undefined);
        }
        return original(message, options);
      });
    await server.connect(serverTransport);
    const client = createClient();
    cleanups.push(async () => {
      await client.close();
      await server.close();
      sending.mockRestore();
    });
    await client.connect(clientTransport);
    const first = await client.callTool({ name: "fixture", arguments: {} });
    expect(first.isError).not.toBe(true);
    expect(first.structuredContent).toEqual({ result: 42 });
    expect(await client.callTool({ name: "fixture", arguments: {} })).toEqual(
      first,
    );
    expect(attempts).toBe(1);
  },
);

it("retains a disconnected lookup through a new connection and joins both at shutdown", async () => {
  const releases: Array<() => void> = [];
  const signals: AbortSignal[] = [];
  const factory = () =>
    new UpdateNotices("1.0.0", async (signal) => {
      signals.push(signal);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      return ok("1.1.0");
    });
  const server = createFixtureServer(factory);
  const open = async () => {
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = createClient();
    await client.connect(clientTransport);
    await client.callTool({ name: "fixture", arguments: {} });
    return client;
  };
  let closing: Promise<void> | undefined;
  const first = await open();
  try {
    await first.close();
    expect(signals[0]?.aborted).toBe(true);
    const second = await open();
    try {
      let closed = false;
      closing = server.close().then(() => {
        closed = true;
      });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      releases[1]?.();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      releases[0]?.();
      await closing;
      expect(closed).toBe(true);
      expect(receivedNotices.get(second)).toHaveLength(0);
    } finally {
      await second.close();
    }
  } finally {
    for (const release of releases) release();
    await closing;
    await first.close();
    await server.close();
  }
});

it("delivers a timestamped unannounced observation while a daily call revalidates", async () => {
  let now = 0;
  let release!: (result: ReturnType<typeof ok<string>>) => void;
  const lookup = vi.fn(
    () =>
      new Promise<ReturnType<typeof ok<string>>>((resolve) => {
        release = resolve;
      }),
  );
  const notices = new UpdateNotices("1.0.0", lookup, () => now);
  const client = await connect(notices);
  try {
    await client.callTool({ name: "fixture", arguments: {} });
    release(ok("1.1.0"));
    await vi.waitFor(() => expect(notices.peek()).toBeDefined());
    now += 24 * 60 * 60 * 1000;
    await client.callTool({ name: "fixture", arguments: {} });
    expect(lookup).toHaveBeenCalledTimes(2);
    expect(receivedNotices.get(client)).toEqual([
      {
        level: "notice",
        logger: "rea.update",
        data: expect.stringContaining(
          "latest published 1.1.0 as observed at 1970-01-01T00:00:00.000Z",
        ),
      },
    ]);
    release(ok("1.2.0"));
    await vi.waitFor(() => expect(notices.peek()?.version).toBe("1.2.0"));
    await client.callTool({ name: "fixture", arguments: {} });
    expect(receivedNotices.get(client)).toHaveLength(2);
    await client.callTool({ name: "fixture", arguments: {} });
    expect(receivedNotices.get(client)).toHaveLength(2);
  } finally {
    release?.(ok("1.2.0"));
  }
});

it.each(["unavailable", "invalid-metadata", "reject", "malformed"] as const)(
  "preserves timestamped observations after failed revalidation: %s",
  async (failure) => {
    let now = 0;
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(ok("1.1.0"))
      .mockImplementationOnce(async () => {
        if (failure === "reject") throw new Error("offline");
        return failure === "malformed" ? ok("malformed") : err(failure);
      })
      .mockResolvedValueOnce(ok("1.2.0"))
      .mockResolvedValueOnce(ok("1.0.0"));
    const notices = new UpdateNotices("1.0.0", lookup, () => now);
    notices.refresh();
    await vi.waitFor(() => expect(notices.peek()?.version).toBe("1.1.0"));
    const client = await connect(notices);
    now += 24 * 60 * 60 * 1000;
    notices.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notices.peek()?.version).toBe("1.1.0");
    await client.callTool({ name: "fixture", arguments: {} });
    expect(receivedNotices.get(client)).toEqual([
      {
        level: "notice",
        logger: "rea.update",
        data: expect.stringContaining(
          "latest published 1.1.0 as observed at 1970-01-01T00:00:00.000Z",
        ),
      },
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
    now += 24 * 60 * 60 * 1000;
    notices.refresh();
    await vi.waitFor(() => expect(notices.peek()?.version).toBe("1.2.0"));
    now += 24 * 60 * 60 * 1000;
    notices.refresh();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lookup).toHaveBeenCalledTimes(4);
    expect(notices.peek()).toBeUndefined();
  },
);
