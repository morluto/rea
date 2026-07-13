import { createServer, type Server } from "node:http";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProcessScenario, ShimEvent } from "../domain/processCapture.js";

interface Invocation {
  readonly command: string;
  readonly arguments: readonly string[];
  readonly working_directory: string;
}

/** Owned command-shim replay resources for one process scenario. */
export interface CommandShimReplay {
  readonly binPath: string;
  readonly url: string;
  readonly events: readonly ShimEvent[];
  readonly truncated: boolean;
  close(): Promise<void>;
}

const RUNNER = `const command = process.argv[2];
const response = await fetch(process.env.REA_SHIM_LEDGER_URL, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ command, arguments: process.argv.slice(3), working_directory: process.cwd() }),
});
if (!response.ok) process.exit(127);
const route = await response.json();
let elapsed = 0;
for (const output of route.outputs) {
  const wait = Math.max(0, output.at_ms - elapsed);
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  elapsed = output.at_ms;
  (output.stream === "stdout" ? process.stdout : process.stderr).write(output.data);
}
if (route.termination.type === "signal") process.kill(process.pid, route.termination.signal);
else process.exit(route.termination.code);
`;

const shellQuote = (value: string): string =>
  `'${value.replaceAll("'", `'\\''`)}'`;

/** Start bounded executable replay wrappers and their private invocation ledger. */
export const startCommandShimReplay = async (
  scenario: ProcessScenario,
  temporaryRoot: string,
  started: number,
): Promise<CommandShimReplay> => {
  const binPath = join(temporaryRoot, "shims");
  await mkdir(binPath);
  const runnerPath = join(temporaryRoot, "shim-runner.mjs");
  await writeFile(runnerPath, RUNNER, { mode: 0o600, flag: "wx" });
  for (const shim of scenario.command_shims) {
    const path = join(binPath, shim.name);
    const wrapper = `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(runnerPath)} ${shellQuote(shim.name)} "$@"\n`;
    await writeFile(path, wrapper, { mode: 0o700, flag: "wx" });
    await chmod(path, 0o700);
  }

  const events: ShimEvent[] = [];
  let truncated = false;
  const calls = new Map<string, number>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/invoke") {
      response.writeHead(404).end();
      return;
    }
    readInvocation(request)
      .then((invocation) => {
        const shim = scenario.command_shims.find(
          ({ name }) => name === invocation.command,
        );
        const routeIndex = shim?.routes.findIndex(
          ({ arguments: expected }) =>
            JSON.stringify(expected) === JSON.stringify(invocation.arguments),
        );
        const key = `${invocation.command}:${String(routeIndex ?? -1)}`;
        const used = calls.get(key) ?? 0;
        const route =
          shim !== undefined && routeIndex !== undefined && routeIndex >= 0
            ? shim.routes[routeIndex]
            : undefined;
        const outcome =
          route === undefined
            ? "unmatched"
            : used >= route.max_calls
              ? "exhausted"
              : "matched";
        if (events.length >= scenario.limits.protocol_events) truncated = true;
        else
          events.push({
            sequence: events.length,
            at_ms: Math.max(0, Date.now() - started),
            command: invocation.command,
            arguments: invocation.arguments,
            working_directory: invocation.working_directory,
            outcome,
          });
        if (outcome !== "matched" || route === undefined) {
          response.writeHead(409).end();
          return;
        }
        calls.set(key, used + 1);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end(JSON.stringify(route));
      })
      .catch(() => response.writeHead(400).end());
  });
  await listen(server);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw new Error("command shim ledger did not bind an IPv4 port");
  }
  return {
    binPath,
    url: `http://127.0.0.1:${String(address.port)}/invoke`,
    events,
    get truncated() {
      return truncated;
    },
    close: () => closeServer(server),
  };
};

const readInvocation = async (
  request: import("node:http").IncomingMessage,
): Promise<Invocation> => {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 64 * 1024) throw new Error("shim invocation exceeds limit");
    chunks.push(buffer);
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (
    typeof value !== "object" ||
    value === null ||
    !("command" in value) ||
    typeof value.command !== "string" ||
    !("arguments" in value) ||
    !Array.isArray(value.arguments) ||
    !value.arguments.every((item) => typeof item === "string") ||
    !("working_directory" in value) ||
    typeof value.working_directory !== "string"
  )
    throw new Error("invalid shim invocation");
  return {
    command: value.command,
    arguments: value.arguments,
    working_directory: value.working_directory,
  };
};

const listen = (server: Server): Promise<void> =>
  new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolveClose, rejectClose) =>
    server.close((cause) =>
      cause === undefined ? resolveClose() : rejectClose(cause),
    ),
  );
