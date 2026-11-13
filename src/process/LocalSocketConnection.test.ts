import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { connectLocalSocketOnce } from "./LocalSocketConnection.js";

for (const transport of ["tcp", "unix"] as const)
  it.skipIf(transport === "unix" && process.platform === "win32")(
    `connects a real local ${transport} socket and transfers ownership`,
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "rea-local-socket-"));
      const server = createServer();
      const path = join(directory, "socket");
      try {
        if (transport === "unix") server.listen(path);
        else server.listen(0, "127.0.0.1");
        await once(server, "listening");
        const incoming = once(server, "connection");
        const target =
          transport === "unix"
            ? { path }
            : {
                host: "127.0.0.1",
                port: (server.address() as AddressInfo).port,
              };
        const result = await connectLocalSocketOnce(
          target,
          new AbortController().signal,
        );
        if (!result.ok)
          throw new Error(`Connection failed: ${result.error.kind}`);
        const [peer] = await incoming;
        result.value.destroy();
        peer.destroy();
      } finally {
        await new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        );
        await rm(directory, { recursive: true, force: true });
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
  expect(result).toEqual({ ok: false, error: { kind: "cancelled", reason } });
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
    expect(await pending).toEqual({
      ok: false,
      error: { kind: "cancelled", reason },
    });
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

it.skipIf(process.platform === "win32")(
  "reports a local socket connection failure",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "rea-missing-socket-"));
    try {
      const result = await connectLocalSocketOnce(
        { path: join(directory, "missing") },
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        ok: false,
        error: { kind: "error", cause: { code: "ENOENT" } },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
