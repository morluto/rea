import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join, relative } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
  type ServerContext,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { onTestFinished } from "vitest";

import { DesktopBuildComputers } from "../../src/application/desktop/DesktopBuildComputers.js";
import { createTestTempDirectory } from "./temporaryDirectory.js";

/** A 2x1 PNG of a black and a white pixel, the fake driver's drawn desktop. */
export const FAKE_FRAME_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR42mNgYGD4//8/AAYBAv67yYXpAAAAAElFTkSuQmCC";
/** A 2x1 PNG of two black pixels, a display the desktop has not drawn on yet. */
const FAKE_BLANK_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAC0lEQVR42mNgAAMAAAcAASEi2xMAAAAASUVORK5CYII=";
/** The fake recording's segments, in order, as the driver keeps them under `rec-000000000001/`. */
export const FAKE_SEGMENTS = [
  Buffer.from("not really an mp4 segment"),
  Buffer.from("nor is this second one"),
];
const segmentPath = (index: number) =>
  `rec-000000000001/${String(index).padStart(4, "0")}.mp4`;

/** How the fake driver misbehaves, when a test asks it to. */
export interface FakeComputerOptions {
  /** Polls answered not ready before readiness passes. */
  readonly notReadyPolls?: number;
  /** Readiness reports a final failed check instead. */
  readonly readinessFails?: boolean;
  /** Base64 characters in each screenshot's image, in place of a drawn PNG. */
  readonly frameCharacters?: number;
  /** Screenshots answered with one black frame before the desktop is drawn. */
  readonly blankFrames?: number;
  /** How long each screenshot, in order, waits before its reply, unless its request is cancelled. */
  readonly screenshotDelaysMs?: readonly number[];
  /** Bytes data/get appends to each segment beyond its manifest size. */
  readonly segmentPadding?: number;
  /** Recording starts, in order, whose recording begins but whose reply is lost. */
  readonly lostRecordingStarts?: number;
  /** Run computer-exec commands on this host in `home`, with `bin` first on PATH and `env` added. */
  readonly exec?: {
    readonly home: string;
    readonly bin: string;
    readonly env?: Readonly<Record<string, string>>;
    /** Controller commands, in order, whose command runs but whose reply is lost. */
    readonly dropReplies?: string[];
  };
  /** The one app the card lists. */
  readonly app?: FakeApp;
}

const COMPUTER_TOOLS = [
  "computer_screenshot",
  "computer_click",
  "computer_drag",
  "computer_scroll",
  "computer_type",
  "computer_key",
  "computer_wait",
] as const;

/** The one app a fake computer lists, serving data/get with its state views and data/reset to its seed. */
export interface FakeApp {
  readonly name: string;
  /** The views data/get answers now; a test sets them as the app's state changes. */
  state: Record<string, unknown>;
  readonly seed: Record<string, unknown>;
  /** The data methods the app was asked, in order. */
  readonly methods: string[];
  /** data/get calls still to answer with an error, as a busy app would. */
  failGets?: number;
  /**
   * Called as each data/get arrives, before its answer, as an app saving on
   * its own timer changes its files; the answer waits for a promise it returns.
   */
  onGet?: () => void | Promise<void>;
  /** Readiness polls answered not ready after each data/reset, as a slow relaunch would. */
  readonly unreadyAfterReset?: number;
  /** Readiness polls left before the relaunched app is ready. */
  unready?: number;
}

/** A local stand-in for an agentenv computer's driver: readiness, `computer_*` MCP tools, recording and data/get. */
export interface FakeComputer {
  readonly url: string;
  readonly token: string;
  /** Every `computer_*` call the driver received, with its arguments as sent. */
  readonly calls: { name: string; arguments: Record<string, unknown> }[];
  /** Paths of framework-only routes called without the control token. */
  readonly unauthorized: string[];
  readonly recordingRequests: { path: string; body: unknown }[];
  /** The paths each data/get asked for, one entry per request. */
  readonly dataRequests: unknown[];
  /** Refuse the next call of a tool as the driver refuses one, with its message. */
  refuseNext(name: string, message: string): void;
  close(): Promise<void>;
}

const readBody = async (request: IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
};

const sendJson = (response: ServerResponse, status: number, value: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(value));
};

/** The driver's `computer_*` tools over streamable HTTP, recording each call and refusing on request. */
const startFakeDriver = async (
  calls: FakeComputer["calls"],
  refusals: Map<string, string>,
  options: FakeComputerOptions,
) => {
  const frameData =
    options.frameCharacters === undefined
      ? FAKE_FRAME_PNG
      : "A".repeat(options.frameCharacters);
  let blankFrames = options.blankFrames ?? 0;
  let screenshots = 0;
  const mcp = new McpServer({ name: "fake-reference-driver", version: "1" });
  for (const name of COMPUTER_TOOLS)
    mcp.registerTool(
      name,
      { description: name, inputSchema: z.looseObject({}) },
      async (args: Record<string, unknown>, context: ServerContext) => {
        calls.push({ name, arguments: args });
        if (name === "computer_screenshot") {
          screenshots += 1;
          const wait = options.screenshotDelaysMs?.[screenshots - 1] ?? 0;
          if (wait > 0)
            await delay(wait, undefined, {
              signal: context.mcpReq.signal,
              ref: false,
            }).catch(() => undefined);
        }
        const refusal = refusals.get(name);
        if (refusal !== undefined) {
          refusals.delete(name);
          return { content: [{ type: "text", text: refusal }], isError: true };
        }
        const frame = { frame_id: `f${String(calls.length)}`, width: 1280 };
        const blank = name === "computer_screenshot" && blankFrames > 0;
        if (blank) blankFrames -= 1;
        const image =
          name === "computer_screenshot" || args.screenshot === true
            ? [
                {
                  type: "image" as const,
                  data: blank ? FAKE_BLANK_PNG : frameData,
                  mimeType: "image/png",
                },
              ]
            : [];
        return {
          content: [{ type: "text" as const, text: `${name} done` }, ...image],
          structuredContent:
            name === "computer_screenshot"
              ? frame
              : { applied: "yes", ...(image.length === 0 ? {} : { frame }) },
        };
      },
    );
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => "fake-session",
    enableJsonResponse: true,
  });
  await mcp.connect(transport);
  return { mcp, transport };
};

/** Every file under home-relative paths, as the driver's data plane answers data/get. */
const homeFileParts = async (home: string, paths: readonly string[]) => {
  const parts: unknown[] = [];
  const visit = async (path: string): Promise<void> => {
    const entry = await stat(path).catch(() => undefined);
    if (entry?.isDirectory() === true)
      for (const name of (await readdir(path)).sort())
        await visit(join(path, name));
    else if (entry?.isFile() === true)
      parts.push({
        kind: "file",
        file: { bytes: (await readFile(path)).toString("base64") },
        metadata: {
          "urn:agentenv:data-objects/v1": { path: relative(home, path) },
        },
      });
  };
  for (const path of paths) await visit(join(home, path));
  return parts;
};

/** The most of a command's stdout the computer's computer-exec answers with. */
const EXEC_STDOUT_BYTES = 1024 * 1024;

/** Run one computer-exec command on this host as the computer would: in the home, its stdin closed, its stdout cut at the cap. */
const runExec = (
  exec: NonNullable<FakeComputerOptions["exec"]>,
  token: string,
  argv: readonly string[],
) =>
  new Promise<Record<string, unknown>>((resolve, reject) => {
    const [command = "", ...rest] = argv;
    const child = spawn(command, rest, {
      cwd: exec.home,
      env: {
        ...process.env,
        ...exec.env,
        HOME: exec.home,
        PATH: `${exec.bin}:${process.env.PATH ?? ""}`,
        AGENTENV_CONTROL_TOKEN: token,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => (stderr += String(chunk)));
    child.once("error", reject);
    child.once("close", (code) => {
      const output = Buffer.concat(stdout);
      resolve({
        exit_code: code,
        stdout: output.subarray(0, EXEC_STDOUT_BYTES).toString("utf8"),
        stderr,
        truncated: output.length > EXEC_STDOUT_BYTES,
        timed_out: false,
      });
    });
  });

/** A reply the fake loses after doing the work, as a dropped connection would. */
const LOST = Symbol("lost reply");

/** One of the app's data methods. */
const appRoute = async (
  app: FakeApp,
  request: { id?: number; method?: string },
) => {
  const method = request.method ?? "";
  app.methods.push(method);
  if (method === "data/get") await app.onGet?.();
  if (method === "data/get" && (app.failGets ?? 0) > 0) {
    app.failGets = (app.failGets ?? 0) - 1;
    return {
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32000, message: "the app is busy", data: {} },
    };
  }
  if (method === "data/reset") {
    app.state = structuredClone(app.seed);
    app.unready = app.unreadyAfterReset ?? 0;
  }
  return {
    jsonrpc: "2.0",
    id: request.id,
    result:
      method === "data/get"
        ? {
            parts: [
              // Each file's bytes follow its view, so they change when the state does.
              ...Object.entries(app.state).map(([path, view]) => ({
                kind: "file",
                file: {
                  bytes: Buffer.from(JSON.stringify(view)).toString("base64"),
                  name: path.split("/").at(-1),
                },
                metadata: { "urn:agentenv:data-objects/v1": { path } },
              })),
              { kind: "data", data: { state: app.state } },
            ],
          }
        : {},
  };
};

/** Not ready while the app relaunches after a reset; undefined once it is, for the usual readiness. */
const relaunching = (app: FakeApp | undefined) => {
  if (app === undefined || (app.unready ?? 0) === 0) return undefined;
  app.unready = (app.unready ?? 0) - 1;
  return { ready: false, checks: [{ name: app.name, ok: false }] };
};

/** One command run as the computer would, its reply lost when the test asks. */
const execRoute = async (
  exec: NonNullable<FakeComputerOptions["exec"]>,
  token: string,
  argv: readonly string[],
) => {
  const answer = await runExec(exec, token, argv);
  const { dropReplies } = exec;
  if (dropReplies === undefined || dropReplies[0] !== argv[4]) return answer;
  dropReplies.shift();
  return LOST;
};

/** The card, the app's data methods, exec and home files, when the fake serves them; undefined for other routes. */
const buildRoute = async (
  options: FakeComputerOptions,
  token: string,
  path: string,
  parsed: unknown,
): Promise<unknown> => {
  const { app, exec } = options;
  const request = parsed as {
    id?: number;
    method?: string;
    argv?: string[];
    params?: { paths?: string[] };
  };
  if (path === "/.well-known/agent-env.json")
    return {
      name: "fake-computer",
      children_environments:
        app === undefined
          ? []
          : [{ name: app.name, url: `/svc/${app.name}/agentenv` }],
    };
  if (app !== undefined && path === `/svc/${app.name}/agentenv`)
    return appRoute(app, request);
  if (path === "/agentenv/ext/computer-ready/status") return relaunching(app);
  if (exec === undefined) return undefined;
  if (path === "/agentenv/ext/computer-exec/run")
    return execRoute(exec, token, request.argv ?? []);
  const paths = request.params?.paths ?? [];
  // Recordings keep the canned segment; other paths are the home's files.
  if (
    path !== "/agentenv" ||
    (paths[0] ?? ".agentenv-recordings/").startsWith(".agentenv-recordings/")
  )
    return undefined;
  return {
    jsonrpc: "2.0",
    id: request.id,
    result: { parts: await homeFileParts(exec.home, paths) },
  };
};

interface FakeState {
  readonly options: FakeComputerOptions;
  readonly recordingRequests: FakeComputer["recordingRequests"];
  readonly dataRequests: unknown[];
  polls: number;
  lostStarts: number;
}

const segments = FAKE_SEGMENTS.map((bytes, index) => ({
  index,
  path: segmentPath(index),
  bytes: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
}));

/** The framework-only routes the token guards: readiness, recording and the driver's data/get. */
const frameworkRoute = (
  state: FakeState,
  path: string,
  parsed: unknown,
): unknown => {
  if (path === "/agentenv/ext/computer-ready/status") {
    state.polls += 1;
    const ready =
      state.options.readinessFails !== true &&
      state.polls > (state.options.notReadyPolls ?? 0);
    return {
      ready,
      checks: [
        {
          name: "display",
          ok: ready,
          detail: state.options.readinessFails === true ? "Xvfb exited" : "",
          ...(state.options.readinessFails === true ? { final: true } : {}),
        },
      ],
    };
  }
  if (path.startsWith("/agentenv/ext/computer-recording/")) {
    state.recordingRequests.push({ path, body: parsed });
    if (path.endsWith("/start") && state.lostStarts > 0) {
      state.lostStarts -= 1;
      return LOST;
    }
    return path.endsWith("/start")
      ? {
          recording_id: "rec-000000000001",
          started_at: "2026-11-05T00:00:00Z",
          format: "video/mp4; codecs=avc1",
        }
      : {
          recording_id: "rec-000000000001",
          fps: 10,
          started_at: "2026-11-05T00:00:00Z",
          ended_at: "2026-11-05T00:00:15Z",
          ended_by: "request",
          segments,
        };
  }
  const { id, params } = parsed as { id: number; params: { paths: string[] } };
  state.dataRequests.push(params.paths);
  const padding = Buffer.alloc(state.options.segmentPadding ?? 0, 0x20);
  return {
    jsonrpc: "2.0",
    id,
    result: {
      parts: FAKE_SEGMENTS.flatMap((bytes, index) => {
        const home = `.agentenv-recordings/${segmentPath(index)}`;
        return params.paths.some(
          (requested) => home === requested || home.startsWith(`${requested}/`),
        )
          ? [
              {
                kind: "file",
                file: {
                  bytes: Buffer.concat([bytes, padding]).toString("base64"),
                  name: home.split("/").at(-1),
                },
                metadata: { "urn:agentenv:data-objects/v1": { path: home } },
              },
            ]
          : [];
      }),
    },
  };
};

/** Start the fake driver, with the misbehaviour a test asks for. */
export const startFakeComputer = async (
  options: FakeComputerOptions = {},
): Promise<FakeComputer> => {
  const token = "fake-control-token-0123456789abcdef";
  const calls: FakeComputer["calls"] = [];
  const unauthorized: string[] = [];
  const state: FakeState = {
    options,
    recordingRequests: [],
    dataRequests: [],
    polls: 0,
    lostStarts: options.lostRecordingStarts ?? 0,
  };
  const refusals = new Map<string, string>();
  const { mcp, transport } = await startFakeDriver(calls, refusals, options);
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const body = await readBody(request);
      // REA's client needs no server-initiated stream; a 405 says so.
      if (url.pathname === "/mcp" && request.method === "GET") {
        sendJson(response, 405, {});
        return;
      }
      if (url.pathname === "/mcp") {
        const headers = new Headers();
        for (const [key, value] of Object.entries(request.headers))
          if (typeof value === "string") headers.set(key, value);
        const answer = await transport.handleRequest(
          new Request(url, {
            method: request.method ?? "GET",
            headers,
            ...(body.length === 0 ? {} : { body }),
          }),
        );
        response.writeHead(answer.status, Object.fromEntries(answer.headers));
        response.end(Buffer.from(await answer.arrayBuffer()));
        return;
      }
      if (request.headers.authorization !== `Bearer ${token}`) {
        unauthorized.push(url.pathname);
        sendJson(response, 401, { ok: false });
        return;
      }
      const parsed: unknown = body.length === 0 ? {} : JSON.parse(String(body));
      const answer =
        (await buildRoute(options, token, url.pathname, parsed)) ??
        frameworkRoute(state, url.pathname, parsed);
      if (answer === LOST) response.destroy();
      else sendJson(response, 200, answer);
    })().catch((cause: unknown) => {
      response.destroy(cause instanceof Error ? cause : undefined);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    token,
    calls,
    unauthorized,
    recordingRequests: state.recordingRequests,
    dataRequests: state.dataRequests,
    refuseNext: (name, message) => refusals.set(name, message),
    close: async () => {
      await mcp.close();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
};

/**
 * A stand-in `agent_env.bundle.run_bundle`, which REA's real helper imports:
 * it notes each call, loads each of the bundle's Python files in a child
 * Python as agentenv's `_declare` does, which compiles it and caches its
 * bytecode beside it unless Python is told not to, copies the bundle and
 * writes to stdout as a build would, then hands out the fake computer, or
 * the one the bundle's `fake-computer-url` names.
 */
const FAKE_BUNDLE_MODULE = String.raw`
import glob
import json
import os
import shutil
import signal
import subprocess
import sys
import time
import types

STATE = os.environ["FAKE_STATE"]
DECLARE = """
import importlib.util, sys
folder, file = sys.argv[1], sys.argv[2]
sys.path.insert(0, folder)
spec = importlib.util.spec_from_file_location("computer_driver_module", folder + "/" + file)
spec.loader.get_code(spec.name)
"""


def _note(name, value):
    with open(os.path.join(STATE, name), "a") as handle:
        handle.write(json.dumps(value) + "\n")


def _interrupted(*_):
    _note("interrupted.jsonl", {"pid": os.getpid()})
    raise KeyboardInterrupt("cancelled")


class _Result:
    def __init__(self, run):
        self.runs = (run,)

    def teardown(self):
        _note("teardowns.jsonl", {"pid": os.getpid()})
        still_up = ("sbx-fake",) if os.environ.get("FAKE_TEARDOWN_FAILS") else ()
        report = types.SimpleNamespace(still_up=still_up)
        return types.SimpleNamespace(runs=(types.SimpleNamespace(torn_down=report),))


def run_bundle(root, *, tasks=(), keep=False, emulate=True, sandbox=None, on_progress=None):
    previous = signal.signal(signal.SIGTERM, _interrupted)
    _note("runs.jsonl", {"root": str(root), "tasks": list(tasks), "keep": keep, "emulate": emulate,
                         "sandbox": sandbox})
    for path in glob.glob(os.path.join(root, "envs", "*", "*.py")):
        subprocess.run([sys.executable, "-c", DECLARE, os.path.dirname(path), os.path.basename(path)], check=True)
    shutil.copytree(root, os.path.join(STATE, "bundle"), dirs_exist_ok=True)
    os.system("echo a build writing to stdout")
    print("agentenv writing to stdout")
    on_progress("deploying the computer")
    time.sleep(float(os.environ.get("FAKE_DEPLOY_SECONDS", "0")))
    signal.signal(signal.SIGTERM, previous)
    chatter = int(os.environ.get("FAKE_CHATTER_BYTES", "0"))
    for line in range(chatter // 80):
        print(f"chatter {line:05d}: Get:1 http://ports.ubuntu.com/ubuntu-ports noble/main arm64 libfoo", file=sys.stderr)
    if os.environ.get("FAKE_FAIL"):
        print(f"E: {os.environ['FAKE_FAIL']}", file=sys.stderr, flush=True)
        raise RuntimeError(os.environ["FAKE_FAIL"])
    url = os.environ["FAKE_COMPUTER_URL"]
    named = os.path.join(root, "fake-computer-url")
    if os.path.exists(named):
        with open(named) as handle:
            url = handle.read().strip()
    env = types.SimpleNamespace(environment_url=url, mcp_url=url + "/mcp", sandbox_id="sbx-fake",
                                control_token=os.environ["FAKE_COMPUTER_TOKEN"])
    run = types.SimpleNamespace(context=types.SimpleNamespace(deployed_envs=[env]), error=None, failed_steps=[])
    return _Result(run)
`;

/** A fake runner: an `agent-env` script naming the host's python3 and a fake `agent_env` package on PYTHONPATH. */
export interface FakeAgentEnvRunner {
  readonly state: string;
  readonly environment: Readonly<Record<string, string>>;
  /** Lines one JSON-lines note file holds. */
  notes(name: string): Promise<unknown[]>;
}

export const fakeAgentEnvRunner = async (
  computer: Pick<FakeComputer, "url" | "token">,
): Promise<FakeAgentEnvRunner> => {
  const state = await createTestTempDirectory("fake-agentenv-");
  const python = execFileSync(
    "python3",
    ["-c", "import sys; print(sys.executable)"],
    { encoding: "utf8" },
  ).trim();
  await mkdir(join(state, "site", "agent_env"), { recursive: true });
  const runner = join(state, "agent-env");
  await writeFile(
    runner,
    `#!${python}\n# Stand-in runner: REA reads only its interpreter.\n`,
  );
  await chmod(runner, 0o755);
  await writeFile(join(state, "site", "agent_env", "__init__.py"), "");
  await writeFile(
    join(state, "site", "agent_env", "bundle.py"),
    FAKE_BUNDLE_MODULE,
  );
  return {
    state,
    environment: {
      REA_AGENT_ENV_COMMAND: runner,
      PYTHONPATH: join(state, "site"),
      FAKE_STATE: state,
      FAKE_COMPUTER_URL: computer.url,
      FAKE_COMPUTER_TOKEN: computer.token,
    },
    notes: async (name) => {
      const path = join(state, name);
      try {
        await access(path);
      } catch {
        return [];
      }
      return (await readFile(path, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as unknown);
    },
  };
};

/**
 * A build computer owner over REA's real helper, a fake runner and a fake
 * driver, and a bundle-folder start; the test closes what it starts.
 */
export const fakeBuildComputers = async (
  options: FakeComputerOptions = {},
  environment: Readonly<Record<string, string>> = {},
) => {
  const computer = await startFakeComputer(options);
  onTestFinished(() => computer.close());
  const runner = await fakeAgentEnvRunner(computer);
  const computers = new DesktopBuildComputers({
    ...process.env,
    ...runner.environment,
    ...environment,
  });
  const bundle = await createTestTempDirectory("exported-bundle-");
  await mkdir(join(bundle, "tasks"));
  await writeFile(join(bundle, "tasks", "smoke.json"), "[]\n");
  const start = () =>
    computers.start(
      { source: { kind: "bundle", path: bundle } },
      new AbortController().signal,
    );
  return { computer, runner, computers, start };
};
