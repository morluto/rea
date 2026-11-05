import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

import { createTestTempDirectory } from "./temporaryDirectory.js";

/** A 1x1 PNG, the fake driver's every frame. */
export const FAKE_FRAME_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
export const FAKE_SEGMENT = Buffer.from("not really an mp4 segment");

const COMPUTER_TOOLS = [
  "computer_screenshot",
  "computer_click",
  "computer_drag",
  "computer_scroll",
  "computer_type",
  "computer_key",
  "computer_wait",
] as const;

/** A local stand-in for an agentenv computer's driver: readiness, `computer_*` MCP tools, recording and data/get. */
export interface FakeComputer {
  readonly url: string;
  readonly token: string;
  /** Every `computer_*` call the driver received, with its arguments as sent. */
  readonly calls: { name: string; arguments: Record<string, unknown> }[];
  /** Paths of framework-only routes called without the control token. */
  readonly unauthorized: string[];
  readonly recordingRequests: { path: string; body: unknown }[];
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
) => {
  const mcp = new McpServer({ name: "fake-reference-driver", version: "1" });
  for (const name of COMPUTER_TOOLS)
    mcp.registerTool(
      name,
      { description: name, inputSchema: z.looseObject({}) },
      (args: Record<string, unknown>) => {
        calls.push({ name, arguments: args });
        const refusal = refusals.get(name);
        if (refusal !== undefined) {
          refusals.delete(name);
          return { content: [{ type: "text", text: refusal }], isError: true };
        }
        const frame = { frame_id: `f${String(calls.length)}`, width: 1280 };
        const image =
          name === "computer_screenshot" || args.screenshot === true
            ? [
                {
                  type: "image" as const,
                  data: FAKE_FRAME_PNG,
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

/** Start the fake driver; readiness reports not ready for the first `notReadyPolls` polls. */
export const startFakeComputer = async (
  options: { readonly notReadyPolls?: number } = {},
): Promise<FakeComputer> => {
  const token = "fake-control-token-0123456789abcdef";
  const calls: FakeComputer["calls"] = [];
  const unauthorized: string[] = [];
  const recordingRequests: FakeComputer["recordingRequests"] = [];
  const refusals = new Map<string, string>();
  let polls = 0;
  const { mcp, transport } = await startFakeDriver(calls, refusals);
  const segment = {
    index: 0,
    path: "rec-000000000001/0000.mp4",
    bytes: FAKE_SEGMENT.length,
    sha256: createHash("sha256").update(FAKE_SEGMENT).digest("hex"),
  };
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
      if (url.pathname === "/agentenv/ext/computer-ready/status") {
        polls += 1;
        const ready = polls > (options.notReadyPolls ?? 0);
        sendJson(response, 200, {
          ready,
          checks: [{ name: "display", ok: ready, detail: "" }],
        });
      } else if (url.pathname.startsWith("/agentenv/ext/computer-recording/")) {
        recordingRequests.push({ path: url.pathname, body: parsed });
        sendJson(
          response,
          200,
          url.pathname.endsWith("/start")
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
                segments: [segment],
              },
        );
      } else if (url.pathname === "/agentenv") {
        const { id } = parsed as { id: number };
        sendJson(response, 200, {
          jsonrpc: "2.0",
          id,
          result: {
            parts: [
              {
                kind: "file",
                file: {
                  bytes: FAKE_SEGMENT.toString("base64"),
                  name: "0000.mp4",
                },
                metadata: {
                  "urn:agentenv:data-objects/v1": {
                    path: `.agentenv-recordings/${segment.path}`,
                  },
                },
              },
            ],
          },
        });
      } else sendJson(response, 404, {});
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
    recordingRequests,
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
 * it notes each call, checks the bundle's Python compiles, copies the bundle
 * and writes to stdout as a build would, then hands out the fake computer.
 */
const FAKE_BUNDLE_MODULE = String.raw`
import glob
import json
import os
import shutil
import signal
import time
import types

STATE = os.environ["FAKE_STATE"]


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
        with open(path) as handle:
            compile(handle.read(), path, "exec")
    shutil.copytree(root, os.path.join(STATE, "bundle"), dirs_exist_ok=True)
    os.system("echo a build writing to stdout")
    print("agentenv writing to stdout")
    on_progress("deploying the computer")
    time.sleep(float(os.environ.get("FAKE_DEPLOY_SECONDS", "0")))
    signal.signal(signal.SIGTERM, previous)
    if os.environ.get("FAKE_FAIL"):
        raise RuntimeError(os.environ["FAKE_FAIL"])
    url = os.environ["FAKE_COMPUTER_URL"]
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
