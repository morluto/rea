import { rm } from "node:fs/promises";
import { parseConfig } from "../../src/config/parseConfig.js";
import { AngrProvider } from "../../src/angr/AngrProvider.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { afterEach, describe, expect, it } from "vitest";
import { AngrSessionClient } from "../../src/angr/AngrSessionClient.js";
import { readAngrConfiguration } from "../../src/angr/AngrConfiguration.js";
import { ANGR_PROVIDER_IDENTITY } from "../../src/angr/AngrProviderCapabilities.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import {
  AnalysisProtocolError,
  AnalysisTimeoutError,
} from "../../src/domain/analysisErrorCore.js";
import { createAngrTarget, RecordingAngrMcp } from "../fixtures/angrMcp.js";
import {
  AngrTransportError,
  decodeAngrToolResult,
  isConnectionLoss,
  redactAngrCredentials,
} from "../../src/angr/AngrMcpConnection.js";
import { SdkError, SdkErrorCode } from "@modelcontextprotocol/client";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const configuration = () => {
  const parsed = readAngrConfiguration({ pythonPath: process.execPath });
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
};
const open = async () => {
  const { root, target } = await createAngrTarget();
  roots.push(root);
  const producer = new RecordingAngrMcp(target);
  return {
    target,
    producer,
    client: new AngrSessionClient(configuration(), target, producer),
  };
};

describe("annotation atomicity", () => {
  it("restores the comment when the rename is rejected", async () => {
    const { producer, client } = await open();
    try {
      producer.comments.set("0x1000", "original");
      const result = await client.execute("annotate_native_function", {
        procedure: "main",
        name: "__reject__",
        comment: "replacement",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisInputError");
      expect(producer.comments.get("0x1000")).toBe("original");
      expect(producer.names.get("0x1000")).toBe("main");
    } finally {
      await client.close();
    }
  });
  it("restores the name when the readback fails after the rename", async () => {
    const { producer, client } = await open();
    try {
      producer.overrideCall = (name) => {
        if (
          name === "get_function_info" &&
          producer.names.get("0x1000") === "entry"
        )
          throw new AnalysisProtocolError(
            "angr MCP tool failed: knowledge base unavailable",
          );
        return undefined;
      };
      const result = await client.execute("annotate_native_function", {
        procedure: "main",
        name: "entry",
      });
      expect(result.ok).toBe(false);
      expect(producer.names.get("0x1000")).toBe("main");
    } finally {
      await client.close();
    }
  });
});

describe("cancellation and applied edits", () => {
  it("drops the call-graph cache and reports a rename the server applied before cancellation", async () => {
    const { producer, client } = await open();
    try {
      await client.execute("procedure_callers", { procedure: "main" });
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "rename") controller.abort();
      };
      const cancelled = await client.execute(
        "set_address_name",
        { address: "0x1040", name: "helper_renamed" },
        { signal: controller.signal },
      );
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok)
        expect(cancelled.error._tag).toBe("AnalysisCancelledError");
      expect(producer.names.get("0x1040")).toBe("helper_renamed");
      delete producer.beforeCall;
      const callers = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!callers.ok) throw callers.error;
      expect(
        producer.calls.filter(({ name }) => name === "get_callgraph"),
      ).toHaveLength(2);
      expect(callers.value.result).toEqual(["0x1040"]);
      const dossier = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!dossier.ok) throw dossier.error;
      expect(
        (dossier.value.result as { callers: { name: string }[] }).callers.map(
          ({ name }) => name,
        ),
      ).toEqual(["helper_renamed"]);
    } finally {
      await client.close();
    }
  });
  it("records a flavor change the server applied before cancellation", async () => {
    const { producer, client } = await open();
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "set_decompilation_flavor") controller.abort();
      };
      const cancelled = await client.execute(
        "set_native_decompilation_flavor",
        { flavor: "rust" },
        { signal: controller.signal },
      );
      expect(cancelled.ok).toBe(false);
      delete producer.beforeCall;
      const health = await client.execute("health", {});
      if (!health.ok) throw health.error;
      expect(health.value.result).toMatchObject({
        decompilation_flavor: "rust",
      });
      expect(producer.flavor).toBe("rust");
    } finally {
      await client.close();
    }
  });
});

describe("ownership, startup, and evidence provenance", () => {
  it("retains the project behind a stdio proxy in attached mode when close fails", async () => {
    const { target, producer } = await open();
    producer.overrideCall = (name) =>
      name === "close_project"
        ? { project_id: "other", closed: true }
        : undefined;
    const client = new AngrSessionClient(
      { ...configuration(), mode: "attached" },
      target,
      producer,
    );
    await client.execute("list_procedures", {});
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    if (!closed.ok)
      expect(closed.error.cleanupResources).toEqual(["angr project p1"]);
    expect(producer.closes).toBe(0);
    delete producer.overrideCall;
    expect((await client.close()).ok).toBe(true);
    expect(producer.openProjects.size).toBe(0);
  });
  it("closes a project whose load reply could not be fully decoded", async () => {
    const { producer, client } = await open();
    producer.overrideCall = (name, args) => {
      if (name !== "load_binary") return undefined;
      producer.openProjects.add("p1");
      return {
        project_id: "p1",
        binary_path: String(args.binary_path),
        bits: "sixty-four",
      };
    };
    const failed = await client.execute("list_procedures", {});
    expect(failed.ok).toBe(false);
    expect(producer.openProjects.has("p1")).toBe(true);
    expect((await client.close()).ok).toBe(true);
    expect(producer.calls.at(-1)).toMatchObject({
      name: "close_project",
      args: { project_id: "p1" },
    });
    expect(producer.openProjects.size).toBe(0);
  });
  it("replays the cached call-graph reply into later relationship Evidence", async () => {
    const { client } = await open();
    try {
      await client.execute("procedure_callers", { procedure: "main" });
      const dossier = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!dossier.ok) throw dossier.error;
      const observations = (
        dossier.value.rawResult as {
          observations: { tool: string; reused?: true }[];
        }
      ).observations;
      expect(
        observations.filter(({ tool }) => tool === "get_callgraph"),
      ).toEqual([
        expect.objectContaining({ tool: "get_callgraph", reused: true }),
      ]);
    } finally {
      await client.close();
    }
  });
  it("fetches one call graph for both relationship directions in an attached dossier", async () => {
    const { target, producer } = await open();
    const client = new AngrSessionClient(
      { ...configuration(), mode: "attached" },
      target,
      producer,
    );
    try {
      const dossier = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!dossier.ok) throw dossier.error;
      expect(
        producer.calls.filter(({ name }) => name === "get_callgraph"),
      ).toHaveLength(1);
    } finally {
      await client.close();
    }
  });
  it("keeps the analysis profile on partial Evidence from a failed request", async () => {
    const { target, producer } = await open();
    const profile = createAnalysisProfile(ANGR_PROVIDER_IDENTITY, {
      cache_policy: "live",
    });
    const client = new AngrSessionClient(
      configuration(),
      target,
      producer,
      profile,
    );
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "decompile_function") controller.abort();
      };
      const result = await client.execute(
        "analyze_function",
        { procedure: "main" },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (!result.ok)
        expect(result.error.partialObservation).toMatchObject({
          analysis_profile: { digest: profile.digest },
        });
    } finally {
      await client.close();
    }
  });
});

describe("annotation rollback under lost replies", () => {
  it("restores a name the server applied before the caller cancelled", async () => {
    const { producer, client } = await open();
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "rename") controller.abort();
      };
      const result = await client.execute(
        "annotate_native_function",
        { procedure: "main", name: "entry" },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(producer.names.get("0x1000")).toBe("main");
      const renames = producer.calls.filter(({ name }) => name === "rename");
      expect(
        renames.map(
          ({ args }) => (args.items as { new_name: string }[])[0]?.new_name,
        ),
      ).toEqual(["entry", "main"]);
    } finally {
      await client.close();
    }
  });
  it("restores a name when the rename reply cannot be decoded", async () => {
    const { producer, client } = await open();
    try {
      let first = true;
      producer.overrideCall = (name, args) => {
        if (name !== "rename" || !first) return undefined;
        first = false;
        producer.names.set(
          "0x1000",
          String((args.items as { new_name: string }[])[0]?.new_name),
        );
        return {
          project_id: "p1",
          dry_run: false,
          total: 1,
          succeeded: 1,
          unchanged: 0,
          failed: 0,
          skipped: 0,
          results: [],
          functions_affected: [],
        };
      };
      const result = await client.execute("annotate_native_function", {
        procedure: "main",
        name: "entry",
      });
      expect(result.ok).toBe(false);
      expect(producer.names.get("0x1000")).toBe("main");
    } finally {
      await client.close();
    }
  });
  it("restores the comment when cancellation arrives after its reply", async () => {
    const { producer, client } = await open();
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "set_comments") controller.abort();
      };
      const result = await client.execute(
        "annotate_native_function",
        { procedure: "main", comment: "entry point" },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisCancelledError");
        expect(JSON.stringify(result.error.partialObservation)).not.toContain(
          "previous value and whether it was applied are unknown",
        );
      }
      expect(producer.comments.has("0x1000")).toBe(false);
    } finally {
      await client.close();
    }
  });
  it("preserves unknown comment state after an explicit failed reply", async () => {
    const { producer, client } = await open();
    try {
      producer.comments.set("0x1000", "original");
      producer.overrideCall = (name) => {
        if (name !== "set_comments") return undefined;
        return {
          dry_run: false,
          total: 1,
          succeeded: 0,
          unchanged: 0,
          failed: 1,
          skipped: 0,
          results: [
            {
              index: 0,
              kind: "function",
              status: "error",
              function_address: "0x1000",
              function_name: "main",
              target: "0x1000",
              old: null,
              new: null,
              error: "write rejected",
            },
          ],
          functions_affected: [],
        };
      };
      const result = await client.execute("annotate_native_function", {
        procedure: "main",
        comment: "replacement",
      });
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisProtocolError");
        expect(JSON.stringify(result.error.partialObservation)).toContain(
          "previous value and whether it was applied are unknown",
        );
      }
      expect(producer.comments.get("0x1000")).toBe("original");
    } finally {
      await client.close();
    }
  });
});

describe("annotation rollback when the refreshed analysis fails", () => {
  it("restores the name and comment when the dossier cannot be produced", async () => {
    const { producer, client } = await open();
    try {
      producer.comments.set("0x1000", "original");
      producer.overrideCall = (name) => {
        if (name === "get_basic_blocks")
          throw new AnalysisProtocolError(
            "angr MCP tool failed: Failed to disassemble",
          );
        return undefined;
      };
      const result = await client.execute("annotate_native_function", {
        procedure: "main",
        name: "entry",
        comment: "replacement",
      });
      expect(result.ok).toBe(false);
      expect(producer.names.get("0x1000")).toBe("main");
      expect(producer.comments.get("0x1000")).toBe("original");
    } finally {
      await client.close();
    }
  });
  it("restores the name when the caller cancels during the refreshed analysis", async () => {
    const { producer, client } = await open();
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "decompile_function") controller.abort();
      };
      const result = await client.execute(
        "annotate_native_function",
        { procedure: "main", name: "entry" },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error._tag).toBe("AnalysisCancelledError");
      expect(producer.names.get("0x1000")).toBe("main");
    } finally {
      await client.close();
    }
  });
});

describe("explicit document selection", () => {
  it("rejects a document other than the bound target before contacting angr", async () => {
    const { target, producer, client } = await open();
    try {
      const other = await client.execute("set_comment", {
        address: "0x1004",
        comment: "stray",
        document: `${target.path}.other`,
      });
      expect(other.ok).toBe(false);
      if (!other.ok) expect(other.error._tag).toBe("AnalysisInputError");
      expect(producer.connects).toBe(0);
      expect(producer.comments.size).toBe(0);
      const read = await client.execute("procedure_address", {
        procedure: "main",
        document: `${target.path}.other`,
      });
      expect(read.ok).toBe(false);
      const same = await client.execute("procedure_address", {
        procedure: "main",
        document: target.path,
      });
      expect(same.ok && same.value.result).toBe("0x1000");
    } finally {
      await client.close();
    }
  });
});

describe("startup failure provenance", () => {
  it("retains the replies angr returned before startup failed", async () => {
    const { producer, client } = await open();
    try {
      producer.overrideCall = (name) => {
        if (name === "get_cfg")
          throw new AnalysisProtocolError(
            "angr MCP tool failed: CFG recovery exploded",
          );
        return undefined;
      };
      const result = await client.execute("list_procedures", {});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        const partial = JSON.stringify(result.error.partialObservation);
        expect(partial).toContain('"tool":"load_binary"');
        expect(partial).toContain("startup failed");
      }
    } finally {
      await client.close();
    }
  });
});

describe("dossier facet availability and upstream failure reasons", () => {
  it("marks unsupported dossier facets unavailable and failed pseudocode explicitly", async () => {
    const { producer, client } = await open();
    try {
      const ok = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!ok.ok) throw ok.error;
      const facets = (
        ok.value.result as {
          facet_availability: Record<string, { available: boolean }>;
        }
      ).facet_availability;
      expect(facets.pseudocode).toEqual({ available: true });
      expect(facets.callers).toEqual({ available: true });
      expect(facets.comments?.available).toBe(false);
      expect(facets.references?.available).toBe(false);
      expect(facets.cfg?.available).toBe(false);
      producer.overrideCall = (name) => {
        if (name === "decompile_function")
          throw new AnalysisProtocolError(
            "angr MCP tool failed: Function too complex: 60000 blocks exceed max_function_blocks=50000",
          );
        return undefined;
      };
      const degraded = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!degraded.ok) throw degraded.error;
      const result = degraded.value.result as {
        pseudocode: string;
        facet_availability: {
          pseudocode: { available: boolean; reason?: string };
        };
      };
      expect(result.pseudocode).toBe("");
      expect(result.facet_availability.pseudocode.available).toBe(false);
      expect(result.facet_availability.pseudocode.reason).toContain(
        "max_function_blocks",
      );
    } finally {
      await client.close();
    }
  });
  it("keeps the upstream reason in diagnostics when a tool call fails", () => {
    expect(() =>
      decodeAngrToolResult({
        isError: true,
        content: [
          {
            type: "text",
            text: "CFG not built for project p1. Call get_cfg first.",
          },
        ],
      }),
    ).toThrow(
      expect.objectContaining({
        diagnostics: {
          upstream_tool_error:
            "CFG not built for project p1. Call get_cfg first.",
        },
      }),
    );
  });
});

describe("credential redaction in upstream tool errors", () => {
  it("removes configured transport credentials before they reach diagnostics", () => {
    const config = {
      url: "http://127.0.0.1:8000/mcp",
      headers: {
        Authorization: "Bearer fixture-secret-token",
        Cookie: "session=fixture-cookie",
      },
      mode: "attached" as const,
      timeoutMs: 1000,
      startupTimeoutMs: 1000,
      autoLoadLibs: false,
    };
    let thrown: unknown;
    try {
      decodeAngrToolResult(
        {
          isError: true,
          content: [
            {
              type: "text",
              text: "proxy rejected Authorization: Bearer fixture-secret-token with Cookie session=fixture-cookie",
            },
          ],
        },
        (text) => redactAngrCredentials(text, config),
      );
    } catch (cause: unknown) {
      thrown = cause;
    }
    expect(thrown).toBeInstanceOf(AnalysisProtocolError);
    const serialized = JSON.stringify({
      message: (thrown as Error).message,
      diagnostics: (thrown as AnalysisProtocolError).diagnostics,
    });
    expect(serialized).not.toContain("fixture-secret-token");
    expect(serialized).not.toContain("fixture-cookie");
    expect(serialized).toContain("[redacted transport credential]");
  });
});

describe("failed disassembly", () => {
  const undisassembled = {
    project_id: "p1",
    function_address: "0x1000",
    function_name: "main",
    block_count: 2,
    blocks: [
      {
        address: "0x1000",
        size: 16,
        instruction_count: 0,
        instructions: [],
        disasm_error: "Failed to disassemble",
      },
      {
        address: "0x1010",
        size: 16,
        instruction_count: 0,
        instructions: [],
        disasm_error: "Failed to disassemble",
      },
    ],
  };
  it("marks dossier assembly unavailable when no block was disassembled", async () => {
    const { producer, client } = await open();
    try {
      producer.overrideCall = (name) =>
        name === "get_basic_blocks" ? undisassembled : undefined;
      const result = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      const dossier = result.value.result as {
        assembly: string[];
        facet_availability: {
          assembly: { available: boolean; reason?: string };
        };
      };
      expect(dossier.assembly).toEqual([]);
      expect(dossier.facet_availability.assembly.available).toBe(false);
      expect(dossier.facet_availability.assembly.reason).toContain(
        "Failed to disassemble",
      );
    } finally {
      await client.close();
    }
  });
  it("fails assembly reads instead of returning an empty listing", async () => {
    const { producer, client } = await open();
    try {
      producer.overrideCall = (name) =>
        name === "get_basic_blocks" ? undisassembled : undefined;
      for (const operation of [
        "procedure_assembly",
        "read_function_instructions",
      ] as const) {
        const result = await client.execute(operation, { procedure: "main" });
        expect(result.ok).toBe(false);
        if (!result.ok)
          expect(result.error.diagnostics).toMatchObject({ operation });
      }
    } finally {
      await client.close();
    }
  });
  it("keeps assembly available when only some blocks failed", async () => {
    const { producer, client } = await open();
    try {
      producer.overrideCall = (name) =>
        name === "get_basic_blocks"
          ? {
              ...undisassembled,
              blocks: [
                {
                  address: "0x1000",
                  size: 16,
                  instruction_count: 0,
                  instructions: [],
                  disasm_error: "Failed to disassemble",
                },
                {
                  address: "0x1010",
                  size: 16,
                  instruction_count: 1,
                  instructions: [
                    {
                      address: "0x1010",
                      mnemonic: "ret",
                      op_str: "",
                      bytes: "c3",
                    },
                  ],
                },
              ],
            }
          : undefined;
      const result = await client.execute("analyze_function", {
        procedure: "main",
      });
      if (!result.ok) throw result.error;
      const dossier = result.value.result as {
        facet_availability: { assembly: { available: boolean } };
      };
      expect(dossier.facet_availability.assembly.available).toBe(true);
      expect(result.value.limitations).toContainEqual(
        expect.stringContaining("could not disassemble 1 basic block"),
      );
    } finally {
      await client.close();
    }
  });
});

describe("dead session detection", () => {
  it("reports an exited owned server so a reopen replaces the client", async () => {
    const { producer, client } = await open();
    try {
      expect(client.operationHealthSnapshot()).toBeUndefined();
      await client.execute("list_procedures", {});
      expect(client.operationHealthSnapshot()?.state).toBe("idle");
      producer.simulateServerExit();
      expect(client.operationHealthSnapshot()).toMatchObject({
        state: "exited",
        stage: "connection",
      });
      const after = await client.execute("procedure_address", {
        procedure: "main",
      });
      expect(after.ok).toBe(false);
      if (!after.ok)
        expect(JSON.stringify(after.error.diagnostics)).toContain(
          "Reopen the target",
        );
    } finally {
      await client.close();
    }
  });
  it("probes the project in health and marks an externally closed project unreachable", async () => {
    const { target, producer } = await open();
    const client = new AngrSessionClient(
      { ...configuration(), mode: "attached" },
      target,
      producer,
    );
    try {
      expect((await client.execute("health", {})).ok).toBe(true);
      producer.openProjects.clear();
      const health = await client.execute("health", {});
      expect(health.ok).toBe(false);
      expect(client.operationHealthSnapshot()?.state).toBe("unreachable");
    } finally {
      await client.close();
    }
  });
  it("does not treat its own close as a lost server", async () => {
    const { client } = await open();
    await client.execute("list_procedures", {});
    expect((await client.close()).ok).toBe(true);
    expect(client.operationHealthSnapshot()).toBeUndefined();
  });
  it("replaces a dead client when the same target is reopened", async () => {
    const { target } = await createAngrTarget().then((created) => {
      roots.push(created.root);
      return created;
    });
    const config = parseConfig({ REA_ANGR_PYTHON: process.execPath });
    if (!config.ok) throw config.error;
    const producers: RecordingAngrMcp[] = [];
    const session = createTestBinarySession(
      new AngrProvider(config.value, {}, () => {
        const producer = new RecordingAngrMcp(target);
        producers.push(producer);
        return producer;
      }),
    );
    try {
      expect((await session.open(target.path)).ok).toBe(true);
      expect(
        (await session.execute("procedure_address", { procedure: "main" })).ok,
      ).toBe(true);
      producers[0]?.simulateServerExit();
      expect((await session.open(target.path)).ok).toBe(true);
      const after = await session.execute("procedure_address", {
        procedure: "main",
      });
      expect(after.ok && after.value.result).toBe("0x1000");
      expect(producers.length).toBeGreaterThanOrEqual(2);
    } finally {
      await session.close();
    }
  });
});

describe("connection-loss classification", () => {
  it("classifies only closed or unreachable connections as lost", () => {
    expect(
      isConnectionLoss(
        new SdkError(SdkErrorCode.ConnectionClosed, "Connection closed"),
      ),
    ).toBe(true);
    expect(
      isConnectionLoss(
        new SdkError(SdkErrorCode.NotConnected, "Not connected"),
      ),
    ).toBe(true);
    expect(
      isConnectionLoss(new SdkError(SdkErrorCode.SendFailed, "Send failed")),
    ).toBe(true);
    expect(isConnectionLoss(new TypeError("fetch failed"))).toBe(true);
    expect(
      isConnectionLoss(
        new SdkError(SdkErrorCode.RequestTimeout, "Request timed out"),
      ),
    ).toBe(false);
    expect(
      isConnectionLoss(
        new SdkError(SdkErrorCode.InvalidResult, "Invalid result"),
      ),
    ).toBe(false);
    expect(isConnectionLoss(new Error("MCP error -32603: internal"))).toBe(
      false,
    );
  });
  it("keeps a live session usable after a malformed reply", async () => {
    const { producer, client } = await open();
    try {
      await client.execute("list_procedures", {});
      producer.overrideCall = (name) =>
        name === "get_function_info"
          ? { address: "not-a-function-reply" }
          : undefined;
      const malformed = await client.execute("procedure_address", {
        procedure: "main",
      });
      expect(malformed.ok).toBe(false);
      expect(client.operationHealthSnapshot()?.state).toBe("idle");
      delete producer.overrideCall;
      const recovered = await client.execute("procedure_address", {
        procedure: "main",
      });
      expect(recovered.ok && recovered.value.result).toBe("0x1000");
    } finally {
      await client.close();
    }
  });
  it("keeps a live session usable after a request timeout", async () => {
    const { producer, client } = await open();
    try {
      await client.execute("list_procedures", {});
      producer.overrideCall = (name) => {
        if (name === "decompile_function")
          throw new AngrTransportError("MCP error: Request timed out", false);
        return undefined;
      };
      const timedOut = await client.execute("procedure_pseudo_code", {
        procedure: "main",
      });
      expect(timedOut.ok).toBe(false);
      expect(client.operationHealthSnapshot()?.state).toBe("idle");
    } finally {
      await client.close();
    }
  });
  it("marks the session lost when the transport reports a closed connection", async () => {
    const { producer, client } = await open();
    try {
      await client.execute("list_procedures", {});
      producer.overrideCall = (name) => {
        if (name === "decompile_function")
          throw new AngrTransportError("Connection closed", true);
        return undefined;
      };
      const failed = await client.execute("procedure_pseudo_code", {
        procedure: "main",
      });
      expect(failed.ok).toBe(false);
      expect(client.operationHealthSnapshot()?.state).toBe("exited");
    } finally {
      await client.close();
    }
  });
});

describe("attached project closed by another client", () => {
  it("replaces the client on the first reopen after an external close", async () => {
    const { target } = await createAngrTarget().then((created) => {
      roots.push(created.root);
      return created;
    });
    const path = `${roots[roots.length - 1]}/attached.json`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ url: "http://127.0.0.1:8000/mcp" }));
    const config = parseConfig({ REA_ANGR_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    const producers: RecordingAngrMcp[] = [];
    const session = createTestBinarySession(
      new AngrProvider(config.value, {}, () => {
        const producer = new RecordingAngrMcp(target);
        producer.projectId = `p${producers.length + 1}`;
        producers.push(producer);
        return producer;
      }),
    );
    try {
      expect((await session.open(target.path)).ok).toBe(true);
      expect(
        (await session.execute("procedure_address", { procedure: "main" })).ok,
      ).toBe(true);
      // Another client closes the project; no event reaches REA.
      producers[0]?.openProjects.clear();
      expect((await session.open(target.path)).ok).toBe(true);
      const after = await session.execute("procedure_address", {
        procedure: "main",
      });
      expect(after.ok && after.value.result).toBe("0x1000");
      expect(producers.length).toBe(2);
    } finally {
      await session.close();
    }
  });
  it("reuses a live attached client on reopen", async () => {
    const { target } = await createAngrTarget().then((created) => {
      roots.push(created.root);
      return created;
    });
    const path = `${roots[roots.length - 1]}/attached.json`;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify({ url: "http://127.0.0.1:8000/mcp" }));
    const config = parseConfig({ REA_ANGR_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    let created = 0;
    const session = createTestBinarySession(
      new AngrProvider(config.value, {}, () => {
        created += 1;
        return new RecordingAngrMcp(target);
      }),
    );
    try {
      await session.open(target.path);
      await session.execute("procedure_address", { procedure: "main" });
      await session.open(target.path);
      expect(
        (await session.execute("procedure_address", { procedure: "main" })).ok,
      ).toBe(true);
      expect(created).toBe(1);
    } finally {
      await session.close();
    }
  });
});

describe("failed startup", () => {
  it("reports a failed startup so a reopen closes the project and starts fresh", async () => {
    const { target } = await createAngrTarget().then((created) => {
      roots.push(created.root);
      return created;
    });
    const config = parseConfig({ REA_ANGR_PYTHON: process.execPath });
    if (!config.ok) throw config.error;
    const producers: RecordingAngrMcp[] = [];
    const session = createTestBinarySession(
      new AngrProvider(config.value, {}, () => {
        const producer = new RecordingAngrMcp(target);
        producer.projectId = `p${producers.length + 1}`;
        // The first server fails CFG recovery after loading the project.
        if (producers.length === 0)
          producer.overrideCall = (name) => {
            if (name === "get_cfg")
              throw new AnalysisProtocolError(
                "angr MCP tool failed: CFG recovery crashed",
              );
            return undefined;
          };
        producers.push(producer);
        return producer;
      }),
    );
    try {
      expect((await session.open(target.path)).ok).toBe(true);
      const failed = await session.execute("procedure_address", {
        procedure: "main",
      });
      expect(failed.ok).toBe(false);
      expect((await session.open(target.path)).ok).toBe(true);
      const recovered = await session.execute("procedure_address", {
        procedure: "main",
      });
      expect(recovered.ok && recovered.value.result).toBe("0x1000");
      expect(producers.length).toBe(2);
      // The failed client's loaded project was closed when it was replaced.
      expect(producers[0]?.openProjects.size).toBe(0);
    } finally {
      await session.close();
    }
  });
  it("snapshots a failed startup as not started", async () => {
    const { producer, client } = await open();
    try {
      producer.overrideCall = (name) => {
        if (name === "get_cfg")
          throw new AnalysisProtocolError("angr MCP tool failed: boom");
        return undefined;
      };
      expect((await client.execute("list_procedures", {})).ok).toBe(false);
      expect(client.operationHealthSnapshot()).toMatchObject({
        state: "not_started",
        retryAction: "retry",
      });
    } finally {
      await client.close();
    }
  });
});

describe("startup cancellation and request timeouts", () => {
  const count = (producer: RecordingAngrMcp, tool: string) =>
    producer.calls.filter(({ name }) => name === tool).length;
  it("stops after load_binary when cancelled and resumes with the same project", async () => {
    const { producer, client } = await open();
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "load_binary") controller.abort();
      };
      const cancelled = await client.execute(
        "procedure_address",
        { procedure: "main" },
        { signal: controller.signal },
      );
      expect(cancelled.ok).toBe(false);
      if (!cancelled.ok)
        expect(cancelled.error._tag).toBe("AnalysisCancelledError");
      expect(count(producer, "get_cfg")).toBe(0);
      expect(client.operationHealthSnapshot()).toBeUndefined();
      delete producer.beforeCall;
      const resumed = await client.execute("procedure_address", {
        procedure: "main",
      });
      expect(resumed.ok && resumed.value.result).toBe("0x1000");
      expect(count(producer, "load_binary")).toBe(1);
      expect(count(producer, "get_cfg")).toBe(1);
    } finally {
      await client.close();
    }
    expect(producer.openProjects.size).toBe(0);
  });
  it("stops after get_cfg when cancelled and does not repeat it", async () => {
    const { producer, client } = await open();
    try {
      const controller = new AbortController();
      producer.beforeCall = async (name) => {
        if (name === "get_cfg") controller.abort();
      };
      const cancelled = await client.execute(
        "procedure_address",
        { procedure: "main" },
        { signal: controller.signal },
      );
      expect(cancelled.ok).toBe(false);
      expect(count(producer, "get_decompilation_flavor")).toBe(0);
      delete producer.beforeCall;
      expect(
        (await client.execute("procedure_address", { procedure: "main" })).ok,
      ).toBe(true);
      expect(count(producer, "get_cfg")).toBe(1);
      expect(count(producer, "get_decompilation_flavor")).toBe(1);
    } finally {
      await client.close();
    }
  });
  it("reports an upstream timeout as a retryable provider timeout for the REA operation", async () => {
    const { producer, client } = await open();
    try {
      await client.execute("list_procedures", {});
      producer.overrideCall = (name) => {
        if (name === "decompile_function")
          throw new AnalysisTimeoutError("decompile_function", 300_000, {
            diagnostics: { upstream_tool: "decompile_function" },
          });
        return undefined;
      };
      const timedOut = await client.execute("procedure_pseudo_code", {
        procedure: "main",
      });
      expect(timedOut.ok).toBe(false);
      if (!timedOut.ok) {
        expect(timedOut.error).toBeInstanceOf(AnalysisTimeoutError);
        expect(timedOut.error).toMatchObject({
          operation: "procedure_pseudo_code",
          timeoutMs: 300_000,
          diagnostics: { upstream_tool: "decompile_function" },
        });
      }
      expect(client.operationHealthSnapshot()?.state).toBe("idle");
      delete producer.overrideCall;
      expect(
        (await client.execute("procedure_pseudo_code", { procedure: "main" }))
          .ok,
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
