import { spawnSync } from "node:child_process";
import { access, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdaTarget } from "../../tests/fixtures/idaMcp.js";
import { RecordingHexRaysIdaMcp } from "../../tests/fixtures/idaHexRaysMcp.js";
import {
  processTest,
  type TestProcesses,
} from "../../tests/support/process/processFixture.js";
import { functionDossierSchema } from "../domain/native/functionDossier.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  decodeIdaToolResult,
  IdaToolRejection,
  type IdaMcpConnection,
} from "./IdaMcpConnection.js";
import { readCallGraphCallees } from "./IdaCallGraph.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { runHexRaysQuery } from "./IdaHexRaysProtocol.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { WindowsPrivateRuntime } from "../windows/WindowsPrivateRuntime.js";

const roots: string[] = [];
const windowsRuntimes = new Set<WindowsPrivateRuntime>();
beforeEach(() => {
  if (process.platform !== "win32") return;
  const create = WindowsPrivateRuntime.create;
  vi.spyOn(WindowsPrivateRuntime, "create").mockImplementation(
    (parent, prefix) => {
      const runtime = create(parent, prefix);
      windowsRuntimes.add(runtime);
      return runtime;
    },
  );
});
afterEach(async () => {
  try {
    // A retained workspace keeps its native owner, which blocks rm on Windows.
    for (const runtime of windowsRuntimes) {
      await runtime.close();
      windowsRuntimes.delete(runtime);
    }
    for (const root of roots.splice(0))
      await rm(root, { recursive: true, force: true });
  } finally {
    vi.restoreAllMocks();
  }
});

const fixture = async () => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingHexRaysIdaMcp(target);
  const client = new IdaSessionClient(
    {
      command: "ida-mcp",
      args: ["stdio"],
      env: {},
      mode: "headless",
      protocol: "hexrays",
      timeoutMs: 1000,
      workspaceRoot: root,
    },
    target,
    producer,
  );
  return { root, target, producer, client };
};
/** Private workspaces REA allocated beside the fixture target. */
const workspaces = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith("rea-ida-"));

const hasPython = spawnSync("python3", ["--version"]).status === 0;

/** Run the actual generated bridge and queries in one owned Python namespace. */
const pythonBridgeFixture = (processes: TestProcesses) => {
  const fixturePath = fileURLToPath(
    new URL("../../bridge/ida/test_hexrays_queries.py", import.meta.url),
  );
  const python = processes.spawn("python3", [
    "-I",
    "-u",
    "-c",
    [
      "import json, runpy, sys, traceback",
      "sys.modules.update(runpy.run_path(sys.argv[1])['stand_ins']())",
      "namespace = {}",
      "for line in sys.stdin:",
      "    code = json.loads(line)",
      "    if code is None:",
      "        namespace.clear()",
      "        print('null')",
      "        continue",
      "    try:",
      "        source, query = code.rsplit('\\n', 1)",
      "        exec(source, namespace)",
      "        print(json.dumps({'result': eval(query, namespace), 'stdout': '', 'stderr': ''}))",
      "    except Exception:",
      "        print(json.dumps({'error': traceback.format_exc()}))",
    ].join("\n"),
    fixturePath,
  ]);
  const lines = createInterface({ input: python.stdout });
  const replies = lines[Symbol.asyncIterator]();
  const execute = async (code: string | null): Promise<JsonValue> => {
    python.stdin.write(`${JSON.stringify(code)}\n`);
    const reply = await replies.next();
    if (reply.done === true) throw new Error("Hex-Rays fixture exited");
    return JSON.parse(reply.value) as JsonValue;
  };
  const call = vi.fn<IdaMcpConnection["call"]>(async (_name, args) => {
    const reply = await execute(String(args.code));
    return typeof reply === "object" &&
      reply !== null &&
      "error" in reply &&
      typeof reply.error === "string"
      ? decodeIdaToolResult({
          isError: true,
          content: [{ type: "text", text: reply.error }],
        })
      : reply;
  });
  const connection: IdaMcpConnection = {
    connect: async () => [],
    serverInfo: () => null,
    close: async () => undefined,
    detach: () => undefined,
    call,
  };
  return {
    connection,
    call,
    reset: () => execute(null),
    close: () => {
      python.stdin.end();
      lines.close();
    },
  };
};

it.each([1, 500, 1000, 300_000])(
  "keeps the Hex-Rays Python deadline inside the %sms MCP deadline",
  async (timeoutMs) => {
    const producerCall = vi.fn<IdaMcpConnection["call"]>(async () => ({
      result: null,
      stdout: "",
      stderr: "",
    }));
    await runHexRaysQuery(
      {
        connect: async () => [],
        serverInfo: () => null,
        close: async () => undefined,
        detach: () => undefined,
        call: producerCall,
      },
      "lease",
      "server_health",
      {},
      timeoutMs,
    );
    const [tool, args, options] = producerCall.mock.calls[0] ?? [];
    expect(tool).toBe("execute_python");
    expect(options).toMatchObject({ timeoutMs });
    const engineTimeout = Number(args?.timeout) * 1000;
    expect(engineTimeout).toBeGreaterThan(0);
    expect(engineTimeout).toBeLessThan(timeoutMs);
  },
);

describe("Hex-Rays query line", () => {
  it.skipIf(!hasPython)(
    "delivers caller text to the bridge as data for any string content",
    async () => {
      const names = [
        'a"); __import__("os").system("x") #',
        'back\\slash \\N{BULLET} \\x41 """',
        "line\nbreak\r\u2028\u2029\u0085\u0000\u001b",
        "lone \ud800 surrogate and emoji \u{1f600}",
      ];
      let code = "";
      const connection = {
        connect: async () => [],
        serverInfo: () => null,
        close: async () => undefined,
        detach: () => undefined,
        call: async (
          _name: string,
          args: Readonly<Record<string, JsonValue>>,
        ) => {
          code = String(args.code);
          return { result: null, stdout: "", stderr: "" };
        },
      };
      await runHexRaysQuery(
        connection,
        "lease",
        "lookup_funcs",
        { queries: names },
        1000,
      );
      // Parse only the generated line; evaluating literals runs no code.
      const decoded = spawnSync(
        "python3",
        [
          "-I",
          "-c",
          [
            "import ast, json, sys",
            "call = ast.parse(sys.stdin.read().rsplit('\\n', 1)[1], mode='eval').body",
            "assert isinstance(call, ast.Call) and call.func.id == '_rea_query'",
            "tool, arguments = (ast.literal_eval(arg) for arg in call.args)",
            "sys.stdout.write(json.dumps([tool, json.loads(arguments)]))",
          ].join("\n"),
        ],
        { input: code, encoding: "utf8" },
      );
      expect(decoded.stderr).toBe("");
      expect(JSON.parse(decoded.stdout)).toEqual([
        "lookup_funcs",
        { queries: names },
      ]);
    },
  );
});

describe("Hex-Rays IDA MCP startup profile", () => {
  it("retains the private input after an open tool error and observes a late unleased worker", async () => {
    const { producer, client } = await fixture();
    producer.openToolError =
      "IDA MCP tool failed: timed out waiting for idat worker";
    const opened = await client.execute("list_procedures", {});
    if (opened.ok) throw new Error("expected startup timeout");
    expect(opened.error.message).toContain("timed out waiting for idat worker");

    const open = producer.calls.find(({ name }) => name === "open_database");
    const path = open?.args.path;
    if (typeof path !== "string") throw new Error("missing private input path");
    const closing = await client.close();
    if (closing.ok)
      throw new Error("cleanup accepted an empty startup inventory");
    expect(closing.error.cleanupIncomplete).toBe(true);
    await access(path);

    // Nexus can publish the worker after open_database has returned the error.
    const idbPath = path + ".i64";
    producer.peers = [
      { path: idbPath, backend: "idat", status: "unavailable" },
    ];
    const retry = await client.close();
    if (retry.ok)
      throw new Error("expected retained cleanup for the late worker");
    expect(projectAnalysisError(retry.error).details).toMatchObject({
      diagnostics: {
        upstream_sessions: {
          state: "unverified",
          sessions: [
            { owned: false, input_path: idbPath, hexrays_backend: "idat" },
          ],
        },
      },
    });
    expect(producer.calls.some(({ name }) => name === "close_database")).toBe(
      false,
    );
    await access(path);
  });

  it("refuses an inconsistent open and inventory backend without querying or closing the worker", async () => {
    const { root, producer, client } = await fixture();
    producer.openBackend = "idat";
    producer.inventoryBackend = "idalib";
    const result = await client.execute("list_procedures", {});
    if (result.ok) throw new Error("expected inconsistent backend refusal");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: { identity_check: "owned_worker_binding" },
    });
    expect((await client.close()).ok).toBe(false);
    expect(
      producer.calls.some(
        ({ name }) => name === "execute_python" || name === "close_database",
      ),
    ).toBe(false);
    expect(await workspaces(root)).toHaveLength(1);

    producer.inventoryBackend = undefined;
    expect((await client.close()).ok).toBe(true);
    expect(await workspaces(root)).toEqual([]);
  });

  it("names the Hex-Rays profile when the catalog lacks execute_python", async () => {
    const { producer, client } = await fixture();
    producer.tools = ["open_database", "list_databases", "close_database"];
    const result = await client.execute("list_procedures", {});
    if (result.ok) throw new Error("expected a profile mismatch");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: {
        mode: "headless",
        expected_profile: "hexrays",
        missing_tools: ["execute_python"],
      },
    });
    expect(producer.calls).toEqual([]);
  });

  it("names the Hex-Rays registration when another profile meets its catalog", async () => {
    const { root, target } = await createIdaTarget();
    roots.push(root);
    const producer = new RecordingHexRaysIdaMcp(target);
    const client = new IdaSessionClient(
      {
        command: "ida-mcp",
        args: ["stdio"],
        env: {},
        mode: "headless",
        protocol: "modern",
        timeoutMs: 1000,
        workspaceRoot: root,
      },
      target,
      producer,
    );
    const result = await client.execute("list_procedures", {});
    if (result.ok) throw new Error("expected a profile mismatch");
    expect(result.error.userMessage).toContain('"protocol": "hexrays"');
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: {
        expected_profile: "database-supervisor",
        advertised_tools: [...producer.tools].sort(),
        recovery: expect.stringContaining('"protocol": "hexrays"'),
      },
    });
    expect(producer.calls).toEqual([]);
  });
});

processTest.skipIf(!hasPython)(
  "reports complete root scan coverage from the Hex-Rays query bridge",
  async ({ processes }) => {
    const { connection, close } = pythonBridgeFixture(processes);
    try {
      const graph = await readCallGraphCallees(
        async (tool, args) =>
          (await runHexRaysQuery(connection, "lease", tool, args, 1000)).result,
        "0x1000",
      );
      expect(graph.callees).toEqual([{ address: "0x2000", name: "helper" }]);
      expect(graph.coverage).toMatchObject({
        status: "complete",
        discovery: { callees: { status: "unknown" } },
      });
    } finally {
      close();
    }
  },
);

describe("Hex-Rays IDA MCP evidence", () => {
  it.each(["idalib", "idat"])(
    "retains the %s backend with completed reads when decompilation fails",
    async (backend) => {
      const { producer, client } = await fixture();
      producer.openBackend = backend;
      producer.reads.beforeCall = async (name) => {
        if (name === "decompile")
          throw new IdaToolRejection("Fixture decompilation failed");
      };
      try {
        const result = await client.execute("procedure_pseudo_code", {
          procedure: "main",
        });
        if (result.ok) throw new Error("expected decompilation failure");
        expect(projectAnalysisError(result.error)).toMatchObject({
          code: "unreadable_output",
          details: {
            partial_observation: {
              normalized_result: {
                status: "partial",
                target_binding: { status: "not_verified" },
              },
              raw_result: {
                worker_backend: backend,
                observations: [
                  {
                    tool: "execute_python",
                    arguments: { query: "lookup_funcs" },
                  },
                ],
              },
            },
          },
        });
      } finally {
        expect((await client.close()).ok).toBe(true);
      }
    },
  );

  it("refuses a conflicting IDA input hash even when the private file is unchanged", async () => {
    const { target, producer, client } = await fixture();
    producer.recordedInputSha256 = target.sha256.toUpperCase();
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    producer.recordedInputSha256 = "f".repeat(64);
    const result = await client.execute("list_procedures", {});
    if (result.ok) throw new Error("expected input identity refusal");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: { identity_check: "headless_input" },
    });
    expect((await client.close()).ok).toBe(true);
  });

  it("refuses an idat database path outside the verified private workspace", async () => {
    const { producer, client } = await fixture();
    producer.openBackend = "idat";
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    producer.reads.idbPath = "/elsewhere/target.i64";
    const result = await client.execute("list_procedures", {});
    if (result.ok) throw new Error("expected a private database path refusal");
    expect(projectAnalysisError(result.error).details).toMatchObject({
      diagnostics: { identity_check: "headless_input" },
    });
    expect((await client.close()).ok).toBe(true);
  });

  it("keeps the bridge digest and engine output of identity and operation reads", async () => {
    const { producer, client } = await fixture();
    producer.engineOutput = { stdout: "", stderr: "engine warning" };
    const result = await client.execute("list_procedures", {});
    if (!result.ok) throw result.error;
    const raw = result.value.rawResult as {
      health_observations: {
        tool: string;
        arguments: { query: string; bridge_sha256: string };
        output?: { stderr: string };
      }[];
      observations: { output?: { stderr: string } }[];
    };
    // One identity read before and one after the operation.
    expect(raw.health_observations).toHaveLength(2);
    for (const observation of raw.health_observations) {
      expect(observation.tool).toBe("execute_python");
      expect(observation.arguments.query).toBe("server_health");
      expect(observation.arguments.bridge_sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(observation.output?.stderr).toBe("engine warning");
    }
    expect(raw.observations[0]?.output?.stderr).toBe("engine warning");
    expect((await client.close()).ok).toBe(true);
  });
});

describe("Hex-Rays IDA MCP session", () => {
  it.each(["idalib", "idat"])(
    "leases a private %s worker, answers reads through the query bridge, and releases it",
    async (backend) => {
      const { root, target, producer, client } = await fixture();
      producer.openBackend = backend;
      const result = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      const dossier = functionDossierSchema.parse(result.value.result);
      expect(dossier.pseudocode).toBe("int main(void) { return 42; }");
      expect(dossier.callees.map(({ name }) => name)).toEqual(["puts"]);

      const [open] = producer.calls;
      expect(open?.name).toBe("open_database");
      expect(open?.args.set_current).toBe(false);
      expect(open?.args.path).not.toBe(target.path);
      expect(String(open?.args.path)).toContain(root);
      // Every read is the fixed bridge; no other tool can reach the database.
      const reads = producer.calls.filter(
        ({ name }) => !["open_database", "list_databases"].includes(name),
      );
      expect(new Set(reads.map(({ name }) => name))).toEqual(
        new Set(["execute_python"]),
      );
      expect(reads.every(({ args }) => args.instance_id === "lease1")).toBe(
        true,
      );
      expect(
        String(reads[0]?.args.code).startsWith('"""Read-only REA queries'),
      ).toBe(true);
      expect(
        reads
          .slice(1)
          .every(({ args }) =>
            String(args.code).startsWith("# rea-bridge\n_rea_query("),
          ),
      ).toBe(true);
      expect(result.value.rawResult).toMatchObject({ worker_backend: backend });
      const raw = result.value.rawResult as {
        observations: { tool: string; arguments: { query: string } }[];
      };
      expect(raw.observations.map(({ tool }) => tool)).toEqual(
        raw.observations.map(() => "execute_python"),
      );
      expect(raw.observations.map(({ arguments: args }) => args.query)).toEqual(
        expect.arrayContaining([
          "lookup_funcs",
          "disasm",
          "decompile",
          "callees",
        ]),
      );

      expect((await client.close()).ok).toBe(true);
      expect(producer.calls.at(-2)).toMatchObject({
        name: "close_database",
        args: { instance_id: "lease1" },
      });
      expect(producer.calls.at(-1)?.name).toBe("list_databases");
      expect(producer.leases.size).toBe(0);
      expect(producer.closes).toBe(1);
      expect(await workspaces(root)).toEqual([]);
      await access(target.path);
    },
  );

  it("refuses a GUI database and retains the workspace it cannot prove released", async () => {
    const { root, producer, client } = await fixture();
    producer.openBackend = "gui";
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain(
        "instead of a private headless worker",
      );
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    expect(await workspaces(root)).toHaveLength(1);
    // A GUI database is never REA's to release.
    expect(producer.calls.map(({ name }) => name)).not.toContain(
      "close_database",
    );
  });

  it.each([
    { label: "a late lease", leased: true },
    { label: "no visible lease", leased: false },
  ])(
    "retains the workspace after a lost open reply with $label",
    async ({ leased }) => {
      const { root, producer, client } = await fixture();
      producer.openBackend = "idat";
      producer.loseOpenReply = { leased };
      expect((await client.execute("list_procedures", {})).ok).toBe(false);

      const cleanup = await client.close();
      if (cleanup.ok) throw new Error("Expected unverified startup cleanup");
      expect(cleanup.error.cleanupIncomplete).toBe(true);
      expect(
        producer.calls.filter(({ name }) => name === "close_database"),
      ).toEqual(
        leased
          ? [{ name: "close_database", args: { instance_id: "lease1" } }]
          : [],
      );
      expect(producer.leases.size).toBe(0);
      expect(await workspaces(root)).toHaveLength(1);
    },
  );

  it("settles a rejected close by the following inventory", async () => {
    const released = await fixture();
    expect((await released.client.execute("list_procedures", {})).ok).toBe(
      true,
    );
    released.producer.rejectClose = { keepLease: false };
    expect((await released.client.close()).ok).toBe(true);
    expect(await workspaces(released.root)).toEqual([]);

    const retained = await fixture();
    expect((await retained.client.execute("list_procedures", {})).ok).toBe(
      true,
    );
    retained.producer.rejectClose = { keepLease: true };
    const closed = await retained.client.close();
    if (closed.ok) throw new Error("expected retained cleanup");
    expect(projectAnalysisError(closed.error).details).toMatchObject({
      diagnostics: {
        upstream_sessions: {
          state: "unverified",
          sessions: [{ session_id: "lease1", backend: "worker", owned: true }],
        },
      },
    });
    expect(await workspaces(retained.root)).toHaveLength(1);

    // An unconfirmed release is retried, not assumed.
    retained.producer.rejectClose = undefined;
    expect((await retained.client.close()).ok).toBe(true);
    expect(
      retained.producer.calls.filter(({ name }) => name === "close_database"),
    ).toHaveLength(2);
    expect(await workspaces(retained.root)).toEqual([]);
  });
});

describe("Hex-Rays unleased database inventory", () => {
  it.each([
    ["idalib", "available", ""],
    ["idat", "unavailable", ".i64"],
    ["idat", "available", ".i64"],
  ] as const)(
    "uses workspace containment to settle an unleased %s database that is %s",
    async (backend, status, suffix) => {
      const { root, producer, client } = await fixture();
      producer.openBackend = backend;
      expect((await client.execute("list_procedures", {})).ok).toBe(true);
      const path = String(
        producer.calls.find(({ name }) => name === "open_database")?.args.path,
      );
      const listedPath = path + suffix;
      const neighbor = {
        path: join(dirname(path) + "-neighbor", "peer.i64"),
        backend,
        status,
      };
      producer.peers = [{ path: listedPath, backend, status }, neighbor];
      const closed = await client.close();
      expect(closed.ok).toBe(false);
      if (closed.ok) throw new Error("expected retained cleanup");
      expect(closed.error.cleanupIncomplete).toBe(true);
      expect(projectAnalysisError(closed.error).details).toMatchObject({
        diagnostics: {
          hexrays_close: {
            closed: true,
            final_lease: status === "unavailable",
            idb_path: path + ".i64",
          },
          upstream_sessions: {
            state: "unverified",
            sessions: [
              {
                session_id: "",
                backend: "worker",
                owned: false,
                input_path: listedPath,
                is_active: status === "unavailable" ? null : false,
                hexrays_status: status,
              },
            ],
          },
        },
      });
      expect(producer.leases.size).toBe(0);
      expect(await workspaces(root)).toHaveLength(1);
      await access(path);

      producer.peers = [neighbor];
      expect((await client.close()).ok).toBe(true);
      expect(await workspaces(root)).toEqual([]);
      expect(
        producer.calls.filter(({ name }) => name === "close_database"),
      ).toHaveLength(1);
    },
  );
});

describe("Hex-Rays query bridge bootstrap and predicate pushdown", () => {
  processTest.skipIf(!hasPython)(
    "executes the full bridge once and reloads only when Python loses its entry point",
    async ({ processes }) => {
      const { connection, call, reset, close } = pythonBridgeFixture(processes);
      const health = () =>
        runHexRaysQuery(connection, "lease-1", "server_health", {}, 1000);
      try {
        const initial = await health();
        expect(initial.result).toMatchObject({
          status: "ok",
          input_path: "/private/input",
          imagebase: "0x400000",
        });
        const initialSource = call.mock.calls[0]?.[1].code;
        const compact = '# rea-bridge\n_rea_query("server_health", "{}")';
        expect(initialSource).not.toBe(compact);
        expect((await health()).result).toEqual(initial.result);
        expect(call.mock.calls.map(([, { code }]) => code)).toEqual([
          initialSource,
          compact,
        ]);

        await expect(
          runHexRaysQuery(
            connection,
            "lease-1",
            "list_funcs",
            {
              queries: { offset: 0 },
            },
            1000,
          ),
        ).rejects.toThrow(/KeyError: 'count'/);
        expect(call).toHaveBeenCalledTimes(3);

        await reset();
        expect((await health()).result).toEqual(initial.result);
        expect(call.mock.calls.slice(3).map(([, { code }]) => code)).toEqual([
          compact,
          initialSource,
        ]);
        expect((await health()).result).toEqual(initial.result);
        expect(call.mock.lastCall?.[1].code).toBe(compact);
      } finally {
        close();
      }
    },
  );

  it("pushes exact string address lookup and procedure search filters into the Hex-Rays bridge", async () => {
    const { producer, client } = await fixture();
    const byAddress = await client.execute("list_strings", {
      address: "0x3000",
    });
    expect(byAddress.ok).toBe(true);
    if (!byAddress.ok) throw new Error("expected string_at success");
    expect(byAddress.value.result).toEqual([
      { address: "0x3000", value: "a.b\nC" },
    ]);
    expect(
      producer.reads.calls.some(
        ({ name, args }) => name === "string_at" && args.addr === "0x3000",
      ),
    ).toBe(true);
    expect(producer.reads.calls.some(({ name }) => name === "find_regex")).toBe(
      false,
    );

    const procSearch = await client.execute("search_procedures", {
      pattern: "main",
      mode: "literal",
      case_sensitive: true,
    });
    expect(procSearch.ok).toBe(true);
    expect(
      producer.reads.calls.some(
        ({ name, args }) =>
          name === "list_funcs" &&
          typeof args.queries === "object" &&
          args.queries !== null &&
          !Array.isArray(args.queries) &&
          "filter" in args.queries &&
          args.queries.count === 1000,
      ),
    ).toBe(true);
    await client.close();
  });
});

describe("Hex-Rays completed-database retention", () => {
  it("reports an unconfirmed save after a successful retained close", async () => {
    const { root, producer, client } = await fixture();
    expect((await client.execute("health", {})).ok).toBe(true);
    const workspace = dirname(producer.reads.inputPath);
    producer.reads.beforeCall = async (name) => {
      if (name === "list_funcs") throw new Error("fixture later tool failure");
    };
    const result = await client.execute("list_procedures", {});
    if (result.ok) throw new Error("Expected a later tool failure");
    expect(result.error.diagnostics).toMatchObject({
      retained_database: {
        workspace,
        save: "pending",
      },
    });
    const closed = await client.close();
    expect(closed.ok).toBe(true);
    expect(
      producer.calls.filter(({ name }) => name === "close_database"),
    ).toEqual([{ name: "close_database", args: { instance_id: "lease1" } }]);
    expect(result.error.diagnostics).toMatchObject({
      retained_database: {
        workspace,
        save: "unknown",
        reason: expect.stringContaining("no save argument"),
      },
    });
    expect(JSON.stringify(result.error.diagnostics)).not.toContain(
      "REA saves the private database",
    );
    expect(await workspaces(root)).toHaveLength(1);
  });
});
