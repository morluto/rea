import { spawnSync } from "node:child_process";
import { access, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createIdaTarget } from "../../tests/fixtures/idaMcp.js";
import { RecordingHexRaysIdaMcp } from "../../tests/fixtures/idaHexRaysMcp.js";
import { functionDossierSchema } from "../domain/native/functionDossier.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import { readIdaConfiguration } from "./IdaConfiguration.js";
import { IdaSessionClient } from "./IdaSessionClient.js";
import { runHexRaysQuery } from "./IdaHexRaysProtocol.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { RetainedResourceScope } from "../application/AnalysisProvider.js";
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
const resourceScope: RetainedResourceScope = {
  retain: () => undefined,
  run: (operation) => operation(),
};
/** Private workspaces REA allocated beside the fixture target. */
const workspaces = async (root: string) =>
  (await readdir(root)).filter((name) => name.startsWith("rea-ida-"));

describe("Hex-Rays IDA MCP registration", () => {
  it("admits only a headless stdio registration", async () => {
    const { root } = await createIdaTarget();
    roots.push(root);
    const path = join(root, "mcp.json");
    for (const [input, ok] of [
      [
        {
          command: "uvx",
          args: ["ida-mcp", "stdio"],
          mode: "headless",
          protocol: "hexrays",
        },
        true,
      ],
      [
        { command: "uvx", args: ["ida-mcp", "stdio"], protocol: "hexrays" },
        false,
      ],
      [
        {
          url: "http://127.0.0.1:8737/mcp",
          mode: "headless",
          protocol: "hexrays",
        },
        false,
      ],
    ] as const) {
      await writeFile(path, JSON.stringify(input));
      expect(
        (await readIdaConfiguration(path, { resourceScope })).ok,
        JSON.stringify(input),
      ).toBe(ok);
    }
  });
});

const hasPython = spawnSync("python3", ["--version"]).status === 0;

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

describe("Hex-Rays IDA MCP evidence", () => {
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
  it("leases a private idalib worker, answers reads through the query bridge, and releases it", async () => {
    const { root, target, producer, client } = await fixture();
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
    expect(reads.every(({ args }) => args.instance_id === "lease1")).toBe(true);
    expect(
      reads.every(({ args }) =>
        String(args.code).startsWith('"""Read-only REA queries'),
      ),
    ).toBe(true);
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
  });

  it("ignores databases other clients hold", async () => {
    const { producer, client } = await fixture();
    producer.peers = [{ path: "/elsewhere/peer.bin", backend: "idalib" }];
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    expect((await client.close()).ok).toBe(true);
  });

  it("refuses a GUI database and retains the workspace it cannot prove released", async () => {
    const { root, producer, client } = await fixture();
    producer.openBackend = "gui";
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain(
        "instead of a private idalib worker",
      );
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    expect(await workspaces(root)).toHaveLength(1);
    // A GUI database is never REA's to release.
    expect(producer.calls.map(({ name }) => name)).not.toContain(
      "close_database",
    );
  });

  it("adopts and releases a late lease when the open reply was lost", async () => {
    const { root, producer, client } = await fixture();
    producer.loseOpenReply = { leased: true };
    expect((await client.execute("list_procedures", {})).ok).toBe(false);
    expect((await client.close()).ok).toBe(false);
    // The lease is released even though the open itself never completed.
    expect(producer.leases.size).toBe(0);
    expect(producer.calls.map(({ name }) => name)).toContain("close_database");
    expect(await workspaces(root)).toHaveLength(1);
  });

  it("retains the workspace when a lost open reply left no visible lease", async () => {
    const { root, producer, client } = await fixture();
    producer.loseOpenReply = { leased: false };
    expect((await client.execute("list_procedures", {})).ok).toBe(false);
    expect((await client.close()).ok).toBe(false);
    expect(producer.calls.map(({ name }) => name)).not.toContain(
      "close_database",
    );
    expect(await workspaces(root)).toHaveLength(1);
  });

  it("cleans up after an explicit open rejection that left no lease", async () => {
    const { root, producer, client } = await fixture();
    producer.rejectOpen = true;
    expect((await client.execute("list_procedures", {})).ok).toBe(false);
    expect((await client.close()).ok).toBe(true);
    expect(await workspaces(root)).toEqual([]);
  });

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
