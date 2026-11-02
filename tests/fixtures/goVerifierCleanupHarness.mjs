// Runs the actual Go verifier in this process with a fake compiler and one
// authored ownership fault, then reports what it released and in which order.
import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

import { PrivateRuntimeRoot } from "../../dist/process/PrivateRuntimeRoot.js";

const scenario = process.argv[2];
assert.equal(typeof scenario, "string");
// The launching test selects this directory, and the verifier allocates there.
assert.notEqual(process.env.TMPDIR, undefined);
const temporary = tmpdir();

const verifier = new URL("../../scripts/verify-go-binary.mjs", import.meta.url);
const events = [];
const record = (kind) => events.push(kind);

// The launching test's fixture stops only this process, so anything a scenario
// starts is stopped on every exit from here, including a failed assertion.
const exitCleanups = [];
process.once("exit", () => {
  for (const cleanup of exitCleanups) {
    try {
      cleanup();
    } catch {
      // It already ended; the rest still need stopping.
    }
  }
});
process.once("SIGTERM", () => process.exit(1));

const compiler = join(temporary, "fake-go");
writeFileSync(
  compiler,
  `#!/bin/sh
case "$1" in
  version) echo "go version go0.0.0-fake" ;;
  env) printf 'linux\\namd64\\n' ;;
esac
`,
);
chmodSync(compiler, 0o755);
process.env.REA_VERIFY_GO_COMMAND = compiler;

const moduleUrl = (source) =>
  `data:text/javascript,${encodeURIComponent(source)}`;
const replaceSdkModule = (specifier, source, onlyFrom) =>
  registerHooks({
    resolve(requested, context, next) {
      if (
        requested === specifier &&
        (onlyFrom === undefined || context.parentURL === onlyFrom)
      )
        return { shortCircuit: true, url: moduleUrl(source) };
      return next(requested, context);
    },
  });
const useDisposableChild = (mode) => {
  const child = new URL("./goVerifierMcpChild.mjs", import.meta.url);
  process.env.NODE_OPTIONS = `--import=${child.href}`;
  process.env.GO_VERIFIER_CHILD_MODE = mode;
};
const isMcpChild = (child) => child.spawnargs.includes("mcp");

const emit = ChildProcess.prototype.emit;
ChildProcess.prototype.emit = function (event, ...arguments_) {
  if (isMcpChild(this)) {
    if (event === "exit" || event === "close") record(`child-${event}`);
    // Signal directly: a scenario may have replaced ChildProcess#kill.
    if (event === "spawn")
      exitCleanups.push(() => {
        if (this.exitCode === null && this.signalCode === null)
          process.kill(this.pid, "SIGKILL");
      });
  }
  return emit.call(this, event, ...arguments_);
};
const closeRoot = PrivateRuntimeRoot.prototype.close;
PrivateRuntimeRoot.prototype.close = function () {
  record("root-close");
  return closeRoot.call(this);
};
const closeClient = Client.prototype.close;
const closeTransport = StdioClientTransport.prototype.close;
// Each owner refuses once and leaves its child alone, as a failed close can.
const refuseClientCloseOnce = () => {
  Client.prototype.close = function () {
    Client.prototype.close = closeClient;
    return Promise.reject(new Error("authored client close failure"));
  };
};
const refuseTransportCloseOnce = () => {
  StdioClientTransport.prototype.close = function () {
    StdioClientTransport.prototype.close = closeTransport;
    return Promise.reject(new Error("authored transport close failure"));
  };
};

// Fail one read in the real lineage observer, which reads /proc on Linux and runs
// ps elsewhere, so it reports its own unavailable reason on either platform.
const failOneLineageRead = (matchesPsArguments, matchesPath) => {
  let failed = false;
  const failNow = (matches) => {
    if (failed || !matches) return false;
    failed = true;
    return true;
  };
  const refuse = () =>
    Promise.reject(new Error("authored lineage read failure"));
  globalThis.goVerifierLineageReads = {
    spawn: (command, arguments_, options) =>
      failNow(command === "ps" && matchesPsArguments(arguments_))
        ? spawn("/bin/sh", ["-c", "exit 1"], options)
        : spawn(command, arguments_, options),
    readdir: (path, options) =>
      failNow(matchesPath(path)) ? refuse() : readdir(path, options),
    readFile: (path, options) =>
      failNow(matchesPath(path)) ? refuse() : readFile(path, options),
  };
  const lineage = new URL(
    "../../scripts/lib/verifier-run.mjs",
    import.meta.url,
  );
  const reads = "globalThis.goVerifierLineageReads";
  registerHooks({
    resolve(requested, context, next) {
      if (
        context.parentURL === lineage.href &&
        requested === "node:child_process"
      )
        return {
          shortCircuit: true,
          url: moduleUrl(
            `export const spawn = (...a) => ${reads}.spawn(...a);`,
          ),
        };
      if (
        context.parentURL === lineage.href &&
        requested === "node:fs/promises"
      )
        return {
          shortCircuit: true,
          url: moduleUrl(
            `export const readdir = (...a) => ${reads}.readdir(...a);
             export const readFile = (...a) => ${reads}.readFile(...a);`,
          ),
        };
      return next(requested, context);
    },
  });
};
// Start a run-owned process as the release begins, so lineage has one to observe.
const startDescendantDuringRelease = (environment = {}) => {
  useDisposableChild("graceful");
  let descendant;
  Client.prototype.close = async function () {
    Client.prototype.close = closeClient;
    descendant = spawn(
      process.execPath,
      ["--eval", "console.log('ready'); setTimeout(() => {}, 30000)"],
      {
        env: { ...process.env, NODE_OPTIONS: "", ...environment },
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    exitCleanups.push(() => descendant.kill("SIGKILL"));
    // Its run token must be readable before lineage observes it.
    await once(descendant.stdout, "data");
    return closeClient.call(this);
  };
  beforeRetry = async () => {
    const exited = once(descendant, "exit");
    descendant.kill("SIGKILL");
    await exited;
  };
};

const failureMessages = (cause) =>
  cause instanceof AggregateError
    ? cause.errors.flatMap(failureMessages)
    : [cause?.message];
const expectRefusal = async (owner, pattern) => {
  const refusal = await owner.close().then(
    () => assert.fail("The incomplete release must be refused"),
    (cause) => cause,
  );
  assert.match(failureMessages(refusal).join("\n"), pattern);
  record("retry-refused");
};
let beforeRetry = async () => {};

const scenarios = {
  "real-server": () => {},
  "client-constructor": () => {
    replaceSdkModule(
      "@modelcontextprotocol/client",
      `export class Client {
         constructor() { throw new Error("authored client constructor failure"); }
       }`,
      verifier.href,
    );
  },
  "transport-constructor": () => {
    replaceSdkModule(
      "@modelcontextprotocol/client/stdio",
      `export class StdioClientTransport {
         constructor() { throw new Error("authored transport constructor failure"); }
       }`,
    );
  },
  "missing-compiler": () => {
    process.env.REA_VERIFY_GO_COMMAND = join(temporary, "absent-go");
  },
  "spawn-failure": () => {
    process.execPath = join(temporary, "absent-node");
  },
  "unobservable-child": () => {
    beforeRetry = async (owner) => {
      await expectRefusal(owner, /child handle/u);
      process.exit(writeOutcome());
    };
    replaceSdkModule(
      "@modelcontextprotocol/client/stdio",
      `export class StdioClientTransport {
         async start() {}
         async close() {}
         async send() {}
         get stderr() { return null; }
       }`,
    );
  },
  "refused-handshake": () => useDisposableChild("refuses-handshake"),
  "noisy-stderr": () => useDisposableChild("noisy-stderr"),
  "client-close": () => {
    useDisposableChild("graceful");
    refuseClientCloseOnce();
  },
  "transport-close": () => {
    useDisposableChild("graceful");
    // A client that closed cleanly, then the transport's own close refusal.
    Client.prototype.close = function () {
      Client.prototype.close = closeClient;
      return Promise.resolve();
    };
    refuseTransportCloseOnce();
  },
  "both-closes": () => {
    useDisposableChild("graceful");
    refuseClientCloseOnce();
    refuseTransportCloseOnce();
  },
  "root-close": () => {
    useDisposableChild("graceful");
    PrivateRuntimeRoot.prototype.close = function () {
      record("root-close");
      PrivateRuntimeRoot.prototype.close = closeRoot;
      return Promise.reject(new Error("authored root close failure"));
    };
  },
  "late-exit": () => {
    useDisposableChild("ignores-termination");
    // The SDK returns from close() as soon as it has sent this signal. Hold the
    // child past that return, longer than the verifier's next steps can take.
    const kill = ChildProcess.prototype.kill;
    ChildProcess.prototype.kill = function (signal) {
      if (!isMcpChild(this) || signal !== "SIGKILL")
        return kill.call(this, signal);
      if (!events.includes("final-kill")) record("final-kill");
      setTimeout(() => kill.call(this, signal), 400);
      return true;
    };
  },
  "undelivered-kill": () => {
    useDisposableChild("ignores-termination");
    const kill = ChildProcess.prototype.kill;
    ChildProcess.prototype.kill = function (signal) {
      if (isMcpChild(this)) {
        record(`denied-${String(signal)}`);
        return false;
      }
      return kill.call(this, signal);
    };
    beforeRetry = async (owner) => {
      await expectRefusal(owner, /completion/u);
      ChildProcess.prototype.kill = kill;
    };
  },
  "pipe-holder": () => {
    const holder = join(temporary, "pipe-holder.pid");
    const stopHolder = () => {
      // The child wrote this file; removing it keeps the signal to one delivery.
      if (!existsSync(holder)) return;
      const pid = Number(readFileSync(holder, "utf8"));
      rmSync(holder);
      process.kill(pid, "SIGKILL");
    };
    exitCleanups.push(stopHolder);
    useDisposableChild("leaves-pipe-holder");
    beforeRetry = async (owner) => {
      await expectRefusal(owner, /pipes/u);
      stopHolder();
      while (!events.includes("child-close")) await delay(10);
    };
  },
  "live-descendant": () => startDescendantDuringRelease(),
  "foreign-descendant": () =>
    startDescendantDuringRelease({ REA_PROCESS_RUN_ID: "foreign-run" }),
  "unreadable-environment": () => {
    startDescendantDuringRelease();
    failOneLineageRead(
      (arguments_) => arguments_[0] === "eww",
      (path) => String(path).endsWith("/environ"),
    );
  },
  "failed-snapshot": () => {
    useDisposableChild("graceful");
    failOneLineageRead(
      (arguments_) => arguments_[0] === "-axo",
      (path) => path === "/proc",
    );
  },
  "windows-lineage": async () => {
    useDisposableChild("graceful");
    // Reach the real Windows lineage branch and this verifier's decision on it. Every
    // step around that window stays POSIX, so this does not exercise native Windows.
    const setPlatform = (value) =>
      Object.defineProperty(process, "platform", { value });
    const posix = process.platform;
    const { VerifierStdioClientTransport } =
      await import("../../scripts/lib/verifier-stdio-transport.mjs");
    const closeChild =
      VerifierStdioClientTransport.prototype.closeAndVerifyChild;
    VerifierStdioClientTransport.prototype.closeAndVerifyChild =
      async function () {
        await closeChild.call(this);
        setPlatform("win32");
      };
    PrivateRuntimeRoot.prototype.close = function () {
      setPlatform(posix);
      record("root-close");
      return closeRoot.call(this);
    };
  },
};
const setUpScenario = new Map(Object.entries(scenarios)).get(scenario);
assert.ok(setUpScenario, `Unknown scenario: ${scenario}`);
await setUpScenario();

const consoleError = console.error;
let report;
console.error = (text, ...rest) => {
  // Only the verifier's own failure report is a JSON document.
  if (typeof text === "string" && text.startsWith("{"))
    report = JSON.parse(text);
  else consoleError(text, ...rest);
};
const rootEntries = () =>
  readdirSync(temporary).filter((name) => name.startsWith("rea-go-verifier-"));

let failure;
try {
  await import(verifier.href);
} catch (cause) {
  failure = cause;
}
console.error = consoleError;
const retainedAtFailure = rootEntries();
const outcome = {
  failure: {
    name: failure?.name,
    message: failure?.message,
    retained_root: failure?.retainedRoot ?? null,
    messages:
      failure instanceof AggregateError
        ? failure.errors.map(({ message }) => message)
        : [failure?.message],
  },
  report: {
    status: report?.status,
    retained_root: report?.retained_root ?? null,
    descendants: report?.verifier.process_lineage.descendants?.length ?? null,
    lineage_status: report?.verifier.process_lineage.status,
    lineage_reason: report?.verifier.process_lineage.reason ?? null,
    omitted_coverage: report?.omitted_coverage ?? [],
  },
  retained_at_failure: retainedAtFailure.map((name) => join(temporary, name)),
};

function writeOutcome() {
  outcome.events = events;
  console.log(JSON.stringify(outcome));
  return 0;
}

const owner = failure?.cleanupOwner;
if (owner !== undefined) {
  await beforeRetry(owner);
  await owner.close();
  // A completed release stays complete.
  await owner.close();
  outcome.retained_after_retry = rootEntries();
  outcome.root_removed_after_retry =
    retainedAtFailure.length === 1 &&
    !existsSync(join(temporary, retainedAtFailure[0]));
}
// Keep a failed scenario from waiting on the child it reports.
process.exit(writeOutcome());
