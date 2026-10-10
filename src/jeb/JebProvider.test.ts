import { describe, expect, it } from "vitest";

import { JebProvider } from "./JebProvider.js";
import type { JebMcpConnection } from "./JebMcpConnection.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisProtocolError,
  AnalysisCancelledError,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";

const scriptedConnection = (
  responses: Readonly<Record<string, JsonValue | Error>>,
): JebMcpConnection & { readonly calls: unknown[][] } => {
  const calls: unknown[][] = [];
  return {
    calls,
    async connect() {
      return [];
    },
    async call(name, args) {
      calls.push([name, args]);
      const response = responses[name];
      if (response === undefined)
        throw new Error(`Unexpected JEB MCP call: ${name}`);
      if (response instanceof Error) throw response;
      return response;
    },
    async close() {},
  };
};

const providerWith = (connection: JebMcpConnection) =>
  new JebProvider({
    environment: { REA_JEB_MCP_URL: "http://127.0.0.1:8425/mcp" },
    connectionFactory: () => connection,
  });

describe("JebProvider boundary", () => {
  it("normalizes client information and caches engine identity", async () => {
    const connection = scriptedConnection({
      get_client_information: {
        success: true,
        version: "5.48.0.202610071539",
        gui_client: false,
        startup_ts: 1791623439,
      },
    });
    const provider = providerWith(connection);
    const result = await provider.execute({
      operation: "inspect_jeb_client",
      input: {},
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = result.value.result as {
      readonly engine: { readonly version: string | null };
      readonly startup_ts: number | null;
    };
    expect(normalized.engine.version).toBe("5.48.0.202610071539");
    expect(normalized.startup_ts).toBe(1791623439);
    expect(result.value.provider.version).toBe("5.48.0.202610071539");
  });

  it("reports unavailable when the engine endpoint is unreachable", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: new Error(
          "connect ECONNREFUSED 127.0.0.1:8425",
        ),
        list_units: new Error("connect ECONNREFUSED 127.0.0.1:8425"),
      }),
    );
    const availability = await provider.inspectAvailability();
    expect(availability.status).toBe("unavailable");
    const result = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 10, index: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("maps transport failures during an operation to provider unavailability", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        list_units: new Error("connect ECONNREFUSED 127.0.0.1:8425"),
      }),
    );
    const result = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 10, index: 0 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBeInstanceOf(AnalysisCapabilityUnavailableError);
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("preserves engine refusal reasons as unsupported targets", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        decompile_code_item: {
          success: false,
          message:
            "The decompilation failed because the item address does not reference an existing code item",
        },
      }),
    );
    const result = await provider.execute({
      operation: "decompile_jeb_item",
      input: { item_address: "LNope;->x()V", item_kind: "method" },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("does not reference an existing");
  });

  it("derives partial coverage only from a full engine page", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        list_units: {
          success: true,
          units: Array.from({ length: 3 }, (_, index) => ({
            unit_path: `a/class${index}.dex`,
            unit_type: "dex",
          })),
        },
      }),
    );
    const full = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 3, index: 0 },
    });
    expect(
      full.ok &&
        (full.value.result as { coverage: string }).coverage === "partial",
    ).toBe(true);
    const last = await provider.execute({
      operation: "list_jeb_units",
      input: { count: 4, index: 0 },
    });
    expect(
      last.ok &&
        (last.value.result as { coverage: string }).coverage === "complete",
    ).toBe(true);
  });
});

describe("JebProvider target and endpoint selection", () => {
  it("keeps the implicitly selected unit unknown when unit_path is omitted", async () => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: {
          success: true,
          version: "5.48.0",
          gui_client: false,
        },
        decompile_code_item: { success: true, text: "int x() { return 1; }" },
      }),
    );
    const result = await provider.execute({
      operation: "decompile_jeb_item",
      input: { item_address: "LFoo;->x()I", item_kind: "method" },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const normalized = result.value.result as {
      readonly unit_path: string | null;
    };
    expect(normalized.unit_path).toBeNull();
    expect(result.value.limitations.join(" ")).toContain("implicitly");
  });

  it("rejects unusable endpoints at construction", () => {
    const rejection = (value: string): AnalysisInputError => {
      try {
        new JebProvider({ environment: { REA_JEB_MCP_URL: value } });
      } catch (cause) {
        if (cause instanceof AnalysisInputError) return cause;
        throw cause;
      }
      throw new Error("endpoint should have been rejected");
    };
    expect(rejection("ftp://example.invalid/mcp").cause).toMatch(
      /http and https/,
    );
    expect(rejection("http://user:pass@127.0.0.1:8425/mcp").cause).toMatch(
      /credentials/,
    );
  });
});

it("refuses remote endpoints before constructing a connection", () => {
  expect(
    () =>
      new JebProvider({
        environment: { REA_JEB_MCP_URL: "http://example.com/mcp" },
      }),
  ).toThrow(AnalysisInputError);
});

it.each(["list_jeb_units", "decompile_jeb_item"] as const)(
  "rejects an omitted successful payload for %s",
  async (operation) => {
    const provider = providerWith(
      scriptedConnection({
        get_client_information: { success: true, version: "5.48.0" },
        list_units: { success: true },
        decompile_code_item: { success: true },
      }),
    );
    const result = await provider.execute(
      operation === "list_jeb_units"
        ? { operation, input: { count: 10, index: 0 } }
        : {
            operation,
            input: { item_address: "LTest;->x()V", item_kind: "method" },
          },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisProtocolError);
  },
);

it("forwards in-flight cancellation to the MCP call", async () => {
  const controller = new AbortController();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const provider = providerWith({
    async connect() {
      return [];
    },
    async close() {},
    async call(_name, _args, signal) {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal!.addEventListener("abort", () => reject(signal!.reason), {
          once: true,
        }),
      );
      return {};
    },
  });
  const pending = provider.execute(
    { operation: "inspect_jeb_client", input: {} },
    { signal: controller.signal },
  );
  await started;
  controller.abort();
  const result = await pending;
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toBeInstanceOf(AnalysisCancelledError);
});
