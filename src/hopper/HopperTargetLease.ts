import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, rm } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import { join, resolve } from "node:path";
import { HopperStartError } from "../domain/hopperErrors.js";
import { safeParseJson } from "../domain/safeJson.js";

interface HopperTargetLeaseOwner {
  readonly runId: string;
  readonly processId: number;
}

export interface HopperTargetLease {
  readonly release: () => Promise<void>;
}

export type HopperTargetLeaseAcquisition =
  | { readonly acquired: true; readonly lease: HopperTargetLease }
  | { readonly acquired: false; readonly owner: HopperTargetLeaseOwner };

/** Shared private parent of Hopper lease sockets; it outlives individual sessions. */
export const HOPPER_TARGET_LEASE_DIRECTORY = join(
  "/tmp",
  `rea-hopper-${process.getuid?.() ?? 0}`,
);

/** Keep two REA processes from opening duplicate Hopper documents for one target/profile. */
export const acquireHopperTargetLease = async (input: {
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
  readonly runId: string;
  readonly directory?: string;
}): Promise<HopperTargetLeaseAcquisition> => {
  // The canonical path only derives the lease key; it never authorizes access.
  // Common expected `realpath` failures include a missing target or path
  // component (ENOENT, ENOTDIR), an unreadable component (EACCES), or a
  // symlink loop (ELOOP). This catch also falls back for every other error,
  // which may hide a real filesystem problem. The lexical `resolve` fallback
  // still yields a deterministic key, but aliases may take separate leases
  // whenever `realpath` cannot resolve them.
  const targetPath = await realpath(input.targetPath).catch(() =>
    resolve(input.targetPath),
  );
  return acquireLease({
    ...input,
    identity: {
      targetPath,
      targetKind: input.targetKind,
      loaderArgs: input.loaderArgs,
    },
  });
};

/** Reserve the Linux demo's singleton application before it can forward a target to another owner. */
export const acquireLinuxHopperApplicationLease = (input: {
  readonly runId: string;
  readonly directory?: string;
}): Promise<HopperTargetLeaseAcquisition> =>
  acquireLease({ ...input, identity: { application: "linux-hopper-demo" } });

const acquireLease = async (input: {
  readonly identity: Readonly<Record<string, unknown>>;
  readonly runId: string;
  readonly directory?: string;
}): Promise<HopperTargetLeaseAcquisition> => {
  const directory = input.directory ?? HOPPER_TARGET_LEASE_DIRECTORY;
  await ensureLeaseDirectory(directory);
  const key = createHash("sha256")
    .update(JSON.stringify(input.identity))
    .digest("hex")
    .slice(0, 32);
  const socketPath = join(directory, `${key}.sock`);
  const owner = { runId: input.runId, processId: process.pid };

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const server = createServer((socket) => sendOwner(socket, owner));
    const bound = await bind(server, socketPath);
    if (bound) {
      await chmod(socketPath, 0o600);
      let released = false;
      return {
        acquired: true,
        lease: {
          release: async () => {
            if (released) return;
            released = true;
            await closeServer(server);
            await rm(socketPath, { force: true });
          },
        },
      };
    }

    const existingOwner = await readOwner(socketPath);
    if (existingOwner !== undefined)
      return { acquired: false, owner: existingOwner };
    await rm(socketPath, { force: true });
  }

  throw new HopperStartError({
    userMessage:
      "REA could not reserve Hopper for this request. Close competing REA sessions and retry.",
  });
};

const ensureLeaseDirectory = async (directory: string): Promise<void> => {
  let directoryStat: Awaited<ReturnType<typeof lstat>>;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    directoryStat = await lstat(directory);
  } catch (cause: unknown) {
    throw new HopperStartError({
      cause,
      userMessage:
        "REA could not create or inspect its private Hopper lease directory.",
    });
  }
  if (
    directoryStat.isSymbolicLink() ||
    directoryStat.isDirectory() === false ||
    (process.getuid !== undefined && directoryStat.uid !== process.getuid())
  )
    throw new HopperStartError({
      userMessage:
        "REA's Hopper lease directory is not a private directory owned by this user.",
    });
  if ((directoryStat.mode & 0o077) !== 0) await chmod(directory, 0o700);
};

const bind = (server: Server, socketPath: string): Promise<boolean> =>
  new Promise((resolveBind, reject) => {
    const onError = (error: NodeJS.ErrnoException): void => {
      server.removeListener("listening", onListening);
      if (error.code === "EADDRINUSE") resolveBind(false);
      else reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolveBind(true);
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });

const sendOwner = (socket: Socket, owner: HopperTargetLeaseOwner): void => {
  socket.end(`${JSON.stringify(owner)}\n`);
};

const readOwner = (
  socketPath: string,
): Promise<HopperTargetLeaseOwner | undefined> =>
  new Promise((resolveOwner, rejectOwner) => {
    const socket = createConnection(socketPath);
    let response = "";
    let settled = false;
    const fail = (reason: string, cause?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      rejectOwner(
        new HopperStartError({
          cause,
          userMessage: `REA could not verify the existing Hopper lease (${reason}); it was left unchanged. Retry when the owning REA session is responsive.`,
        }),
      );
    };
    const timer = setTimeout(() => fail("owner response timed out"), 250);
    const finish = (owner: HopperTargetLeaseOwner | undefined): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolveOwner(owner);
    };
    socket.on("data", (chunk: Buffer) => {
      response += chunk.toString("utf8");
      const newline = response.indexOf("\n");
      if (newline < 0) return;
      const parsed = safeParseJson(response.slice(0, newline));
      if (!parsed.ok) {
        fail("malformed owner response");
        return;
      }
      const value: unknown = parsed.value;
      const runId =
        typeof value === "object" && value !== null
          ? Reflect.get(value, "runId")
          : undefined;
      const processId =
        typeof value === "object" && value !== null
          ? Reflect.get(value, "processId")
          : undefined;
      if (
        typeof runId === "string" &&
        runId.length > 0 &&
        typeof processId === "number" &&
        Number.isSafeInteger(processId) &&
        processId > 0
      )
        finish({ runId, processId });
      else fail("invalid owner identity");
    });
    socket.on("error", (cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.code === "ECONNREFUSED")
        finish(undefined);
      else fail(cause.code ?? "owner connection failed", cause);
    });
    socket.on("end", () => fail("owner closed without a complete response"));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
