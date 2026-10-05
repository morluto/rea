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

const leaseDirectory = join("/tmp", `rea-hopper-${process.getuid?.() ?? 0}`);

/** Keep two REA processes from opening duplicate Hopper documents for one target/profile. */
export const acquireHopperTargetLease = async (input: {
  readonly targetPath: string;
  readonly targetKind: "executable" | "database";
  readonly loaderArgs: readonly string[];
  readonly runId: string;
  readonly directory?: string;
}): Promise<HopperTargetLeaseAcquisition> => {
  const directory = input.directory ?? leaseDirectory;
  await ensureLeaseDirectory(directory);
  const targetPath = await realpath(input.targetPath).catch(() =>
    resolve(input.targetPath),
  );
  const key = createHash("sha256")
    .update(
      JSON.stringify({
        targetPath,
        targetKind: input.targetKind,
        loaderArgs: input.loaderArgs,
      }),
    )
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
      "REA could not reserve this Hopper target. Close competing REA sessions and retry.",
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
  new Promise((resolveOwner) => {
    const socket = createConnection(socketPath);
    let response = "";
    const timer = setTimeout(() => {
      socket.destroy();
      resolveOwner(undefined);
    }, 250);
    const finish = (owner: HopperTargetLeaseOwner | undefined): void => {
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
        finish(undefined);
        return;
      }
      const value: unknown = parsed.value;
      if (
        typeof value === "object" &&
        value !== null &&
        typeof Reflect.get(value, "runId") === "string" &&
        typeof Reflect.get(value, "processId") === "number"
      )
        finish({
          runId: Reflect.get(value, "runId") as string,
          processId: Reflect.get(value, "processId") as number,
        });
      else finish(undefined);
    });
    socket.on("error", () => finish(undefined));
    socket.on("end", () => finish(undefined));
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, reject) => {
    if (!server.listening) {
      resolveClose();
      return;
    }
    server.close((error) => (error ? reject(error) : resolveClose()));
  });
