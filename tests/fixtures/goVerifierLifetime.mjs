// Exercise the actual verifier entrypoint with a fixture compiler and authored
// SDK/transport failures. The fixture root and command owner remain real.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, writeFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { PrivateRuntimeRoot } from "../../dist/process/PrivateRuntimeRoot.js";
import { createVerifierCommands } from "../../scripts/lib/verify-commands.mjs";

const scenario = process.argv[2];
const directory = process.argv[3];
assert.equal(typeof directory, "string");
const compiler = join(directory, "go-fixture");
await writeFile(
  compiler,
  '#!/bin/sh\ncase "$1" in\nversion) echo "go version fixture";;\nenv) printf "linux\\namd64\\n";;\nesac\n',
);
await chmod(compiler, 0o755);
process.env.REA_VERIFY_GO_COMMAND = compiler;
const events = [];
let retrying = false;
let transport;
const fails = (name) => !retrying && scenario.includes(name);
const state = {
  Client: class {
    constructor() {
      if (fails("client-constructor"))
        throw new Error("client constructor fault");
    }
    async connect(value) {
      transport = value;
      await value.start();
    }
    async close() {
      events.push("client-close");
      if (fails("client-close")) throw new Error("client close fault");
      await transport?.close();
    }
  },
  createTransport() {
    if (fails("transport-constructor"))
      throw new Error("transport constructor fault");
    let closed = false;
    return {
      async start() {
        if (closed) throw new Error("Transport closed before handshake");
        events.push("transport-start");
        if (fails("handshake")) throw new Error("handshake fault");
      },
      async close() {
        events.push("transport-close");
        if (fails("transport-close")) throw new Error("transport close fault");
        // A close promise is the completion boundary, not its initial call.
        await delay(20);
        closed = true;
        events.push("transport-settled");
      },
    };
  },
  async createOwnedMcpStdioTransport() {
    return state.createTransport();
  },
  async createVerifierCommands() {
    const owner = await createVerifierCommands();
    const close = owner.close.bind(owner);
    owner.close = async () => {
      events.push("commands-close");
      if (fails("commands-close")) throw new Error("commands close fault");
      await close();
    };
    return owner;
  },
};
globalThis.goVerifierLifetime = state;
const entrypoint = new URL(
  "../../scripts/verify-go-binary.mjs",
  import.meta.url,
);
const moduleSources = new Map([
  [
    "@modelcontextprotocol/client",
    "export const Client = globalThis.goVerifierLifetime.Client;",
  ],
  [
    "@modelcontextprotocol/client/stdio",
    "export class StdioClientTransport { constructor() { return globalThis.goVerifierLifetime.createTransport(); } }",
  ],
  [
    "./lib/owned-mcp-stdio.mjs",
    "export const createOwnedMcpStdioTransport = globalThis.goVerifierLifetime.createOwnedMcpStdioTransport;",
  ],
  [
    "./lib/verify-commands.mjs",
    "export const createVerifierCommands = globalThis.goVerifierLifetime.createVerifierCommands;",
  ],
]);
const hook = registerHooks({
  resolve(specifier, context, next) {
    const source =
      context.parentURL === entrypoint.href
        ? moduleSources.get(specifier)
        : undefined;
    return source === undefined
      ? next(specifier, context)
      : {
          shortCircuit: true,
          url: `data:text/javascript,${encodeURIComponent(source)}`,
        };
  },
});
const closeRoot = PrivateRuntimeRoot.prototype.close;
let rootPath;
PrivateRuntimeRoot.prototype.close = async function () {
  rootPath = this.path;
  events.push("root-close");
  if (fails("root-close")) throw new Error("root close fault");
  await closeRoot.call(this);
};
const reports = [];
const stderr = console.error;
console.error = (...values) => {
  if (typeof values[0] === "string" && values[0].startsWith("{"))
    reports.push(JSON.parse(values[0]));
  else stderr(...values);
};
let failure;
try {
  await import(entrypoint.href);
} catch (cause) {
  failure = cause;
} finally {
  hook.deregister();
  console.error = stderr;
}
assert.ok(failure, "Fixture compiler intentionally produces no executable");
const messages = (cause) =>
  cause instanceof AggregateError
    ? cause.errors.flatMap(messages)
    : [cause.message];
const report = reports.at(-1);
const retained = report?.retained_root ?? null;
const existedAtFailure = retained !== null && existsSync(retained);
const beforeRetry = [...events];
retrying = true;
for (const lease of failure.cleanupLeases ?? []) await lease.release();
console.log(
  JSON.stringify({
    messages: messages(failure),
    report,
    retained,
    existedAtFailure,
    removedAfterRetry: retained === null || !existsSync(retained),
    rootRemoved: rootPath !== undefined && !existsSync(rootPath),
    beforeRetry,
    events,
  }),
);
