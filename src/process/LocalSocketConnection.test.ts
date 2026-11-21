import { once } from "node:events";
import { createServer, type AddressInfo, type Socket } from "node:net";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createTestTempDirectory } from "../../tests/fixtures/temporaryDirectory.js";
import { connectLocalSocketOnce } from "./LocalSocketConnection.js";

for (const transport of ["tcp", "unix"] as const)
  it.skipIf(transport === "unix" && process.platform === "win32")(
    `connects a real local ${transport} socket and transfers ownership`,
    async () => {
      const path =
        transport === "unix"
          ? join(await createTestTempDirectory("rea-local-socket-"), "socket")
          : undefined;
      const peers = new Set<Socket>();
      const server = createServer((peer) => {
        peers.add(peer);
        peer.once("close", () => peers.delete(peer));
        peer.once("data", (bytes) => peer.end(bytes));
      });
      let client: Socket | undefined;
      try {
        if (path !== undefined) server.listen(path);
        else server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const target =
          path !== undefined
            ? { path }
            : {
                host: "127.0.0.1",
                port: (server.address() as AddressInfo).port,
              };
        const controller = new AbortController();
        const result = await connectLocalSocketOnce(target, controller.signal);
        if (!result.ok)
          throw new Error(`Connection failed: ${result.error.kind}`);
        client = result.value;
        controller.abort();
        expect(client.destroyed).toBe(false);
        client.setEncoding("utf8");
        client.end("ownership receipt");
        let receipt = "";
        for await (const chunk of client) receipt += String(chunk);
        expect(receipt).toBe("ownership receipt");
      } finally {
        client?.destroy();
        for (const peer of peers) peer.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
      }
    },
  );

it("retains an already-aborted caller's reason", async () => {
  const controller = new AbortController();
  const reason = { caller: "cancelled" };
  controller.abort(reason);
  const result = await connectLocalSocketOnce(
    { host: "127.0.0.1", port: -1 },
    controller.signal,
  );
  if (result.ok) {
    result.value.destroy();
    throw new Error("An already cancelled caller connected");
  }
  if (result.error.kind !== "cancelled") throw result.error.cause;
  expect(result.error.reason).toBe(reason);
});

it("cancels an outstanding connection attempt with the caller's reason", async () => {
  const server = createServer((peer) => peer.destroy());
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const controller = new AbortController();
    const reason = { caller: "stop connecting" };
    const pending = connectLocalSocketOnce(
      { host: "127.0.0.1", port: (server.address() as AddressInfo).port },
      controller.signal,
    );
    controller.abort(reason);
    const result = await pending;
    if (result.ok) {
      result.value.destroy();
      throw new Error("A cancelled connection was handed off");
    }
    if (result.error.kind !== "cancelled") throw result.error.cause;
    expect(result.error.reason).toBe(reason);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.skipIf(process.platform === "win32")(
  "reports a local socket connection failure",
  async () => {
    const directory = await createTestTempDirectory("rea-missing-socket-");
    const result = await connectLocalSocketOnce(
      { path: join(directory, "missing") },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      ok: false,
      error: { kind: "error", cause: { code: "ENOENT" } },
    });
  },
);
