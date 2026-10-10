import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createIdaTarget,
  RecordingIdaMcp,
} from "../../tests/fixtures/idaMcp.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { readIdaConfiguration } from "./IdaConfiguration.js";
import {
  decodeIdaToolResult,
  type IdaMcpConnection,
} from "./IdaMcpConnection.js";
import { parseConfig } from "../config/parseConfig.js";
import { IdaProvider } from "./IdaProvider.js";
import { idaCapabilities } from "./IdaProviderCapabilities.js";
import { IdaSessionClient } from "./IdaSessionClient.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

const fixture = async () => {
  const { root, target } = await createIdaTarget();
  roots.push(root);
  const producer = new RecordingIdaMcp(target);
  producer.overrideCall = (name) => {
    if (name === "decompile")
      return {
        addr: "0x1000",
        ok: true,
        pseudocode: producer.pseudocode,
        lines: 1,
      };
    if (name === "disasm")
      return {
        asm: {
          name: "main",
          start_ea: "0x1000",
          lines: "main (.text @ 0x1000):\n1000  ret",
        },
        cursor: { done: true },
      };
    if (name === "callees")
      return [
        {
          callees: [{ addr: "0x2000", name: "puts", type: "external" }],
          more: false,
          error: null,
        },
      ];
    if (name === "xrefs_to")
      return [
        {
          xrefs: [{ addr: "0x1004", type: "code", fn: null }],
          more: false,
          error: null,
        },
      ];
    return undefined;
  };
  const resources: string[] = [];
  const connection: IdaMcpConnection = {
    connect: async () => [
      "list_funcs",
      "lookup_funcs",
      "find_regex",
      "decompile",
      "disasm",
      "callees",
      "xrefs_to",
    ],
    call: (name, args) => producer.call(name, args),
    readResource: async (uri) => {
      resources.push(uri);
      const metadata = await producer.call("get_metadata", {});
      if (
        metadata === null ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      )
        throw new Error("Invalid metadata fixture");
      return { ...metadata, path: `${producer.inputPath}.i64` };
    },
    serverInfo: () => producer.serverInfo(),
    close: () => producer.close(),
  };
  const client = new IdaSessionClient(
    {
      url: "http://127.0.0.1:13337/mcp",
      headers: {},
      mode: "attached",
      protocol: "native",
      timeoutMs: 1000,
    },
    target,
    connection,
  );
  return { producer, client, target, resources, root };
};

describe("native IDA Free attached protocol", () => {
  it("requires explicit opt-in and rejects native headless registrations", async () => {
    const { root } = await fixture();
    const path = join(root, "native.json");
    await writeFile(
      path,
      JSON.stringify({ url: "http://127.0.0.1:13337/mcp", protocol: "native" }),
    );
    expect(readIdaConfiguration(path)).toMatchObject({
      ok: true,
      value: { mode: "attached", protocol: "native" },
    });
    await writeFile(
      path,
      JSON.stringify({
        url: "http://127.0.0.1:13337/mcp",
        protocol: "native",
        mode: "headless",
      }),
    );
    expect(readIdaConfiguration(path).ok).toBe(false);
    await writeFile(path, JSON.stringify({ command: "python" }));
    const old = readIdaConfiguration(path);
    expect(old.ok && old.value.protocol).toBeUndefined();
  });

  it("commits native profile semantics and advertises GUI effects without starting a provider", async () => {
    const { root, target, producer } = await fixture();
    const path = join(root, "profile.json");
    await writeFile(
      path,
      JSON.stringify({ url: "http://127.0.0.1:13337/mcp", protocol: "native" }),
    );
    const config = parseConfig({ REA_IDA_MCP_CONFIG: path });
    if (!config.ok) throw config.error;
    const provider = new IdaProvider(config.value, {}, () => {
      throw new Error("Unexpected discovery startup");
    });
    expect(provider.inspectAvailability().status).toBe("available");
    const profile = await provider.resolveAnalysisProfile(target);
    if (!profile.ok) throw profile.error;
    expect(profile.value.profile.parameters).toMatchObject({
      compatibility_profile: "native-ida-free",
      mode: "attached",
      cache_policy: "live",
      engine_version: null,
    });
    expect(
      provider
        .capabilities()
        .find(({ operation }) => operation === "procedure_pseudo_code")?.effects
        .mayShowUi,
    ).toBe(true);
    expect(producer.connects).toBe(0);
  });

  it("uses complete native JSON text instead of a shortened structured preview", () => {
    const complete = [
      {
        data: [{ addr: "0x1000", name: "main", size: "0x20" }],
        next_offset: null,
      },
    ];
    const response = {
      content: [{ type: "text", text: JSON.stringify(complete) }],
      structuredContent: { result: [], _output_truncated: true },
    };
    expect(decodeIdaToolResult(response, "native")).toEqual(complete);
    expect(() =>
      decodeIdaToolResult({ ...response, content: [] }, "native"),
    ).toThrow("complete JSON");
    expect(() =>
      decodeIdaToolResult(
        { ...response, content: [{ type: "text", text: "broken JSON" }] },
        "native",
      ),
    ).toThrow();
    expect(() =>
      decodeIdaToolResult({ ...response, isError: true }, "native"),
    ).toThrow("tool failed");
  });
});

describe("native IDA Free provider observations", () => {
  it("retains native tool provenance, reads recorded metadata, and closes only its connection", async () => {
    const { client, producer, resources } = await fixture();
    for (const operation of [
      "list_procedures",
      "list_strings",
      "procedure_assembly",
      "procedure_pseudo_code",
      "procedure_callees",
      "xrefs",
      "analyze_function",
    ] as const) {
      const result = await client.execute(
        operation,
        operation === "list_procedures" || operation === "list_strings"
          ? {}
          : operation === "xrefs"
            ? { address: "0x1000" }
            : { procedure: "main" },
      );
      if (!result.ok) throw result.error;
      if (operation === "procedure_assembly")
        expect(result.value.result).toBe("0x1000: ret");
      if (operation === "procedure_pseudo_code") {
        expect(result.value.result).toBe(producer.pseudocode);
        expect(result.value.rawResult).toMatchObject({
          observations: expect.arrayContaining([
            expect.objectContaining({
              tool: "decompile",
              result: {
                addr: "0x1000",
                ok: true,
                pseudocode: producer.pseudocode,
                lines: 1,
              },
            }),
          ]),
        });
      }
    }
    expect(resources).toHaveLength(14);
    expect(new Set(resources)).toEqual(new Set(["ida://idb/metadata"]));
    expect(
      producer.calls.find(({ name }) => name === "find_regex")?.args.pattern,
    ).toBe("[\\s\\S]*");
    expect(
      (await client.execute("procedure_callers", { procedure: "main" })).ok,
    ).toBe(false);
    expect((await client.close()).ok).toBe(true);
    expect(producer.closes).toBe(1);
    expect(producer.calls.some(({ name }) => name.startsWith("idb_"))).toBe(
      false,
    );
    const capabilities = idaCapabilities("attached", false, true);
    expect(
      capabilities.find(({ operation }) => operation === "procedure_callers")
        ?.available,
    ).toBe(false);
    expect(
      capabilities.find(
        ({ operation }) => operation === "procedure_pseudo_code",
      )?.effects,
    ).toMatchObject({ mayShowUi: true, mayAccessNetwork: true });
    expect(
      idaCapabilities("attached", false).find(
        ({ operation }) => operation === "procedure_callers",
      )?.available,
    ).toBe(true);
  });

  it("rejects unavailable or mismatched recorded input hashes and database switches", async () => {
    const { client, producer, target } = await fixture();
    for (const hash of ["unavailable", "a".repeat(64)]) {
      producer.inputSha256 = hash;
      expect((await client.execute("health", {})).ok).toBe(false);
    }
    producer.inputSha256 = target.sha256;
    expect((await client.execute("health", {})).ok).toBe(true);
    producer.inputPath += ".other.i64";
    expect((await client.execute("list_procedures", {})).ok).toBe(false);
    await client.close();
  });
});

describe("native IDA Free malformed observations", () => {
  it("rejects wrong-function pseudocode, upstream cloud failures, and malformed assembly", async () => {
    const { client, producer } = await fixture();
    for (const value of [
      { addr: "0x2000", ok: true, pseudocode: "int wrong(void);" },
      {
        addr: "0x1000",
        ok: false,
        error: "No pseudocode widget for this function after decompilation",
      },
      { addr: "0x1000", ok: true },
    ]) {
      producer.overrideCall = (name) =>
        name === "decompile" ? value : undefined;
      const result = await client.execute("procedure_pseudo_code", {
        procedure: "main",
      });
      expect(result.ok).toBe(false);
    }
    producer.overrideCall = (name) =>
      name === "disasm"
        ? {
            asm: {
              name: "main",
              start_ea: "0x1000",
              lines: "main (.text @ 0x1000):\nunsupported",
            },
            cursor: { done: true },
          }
        : undefined;
    expect(
      (await client.execute("procedure_assembly", { procedure: "main" })).ok,
    ).toBe(false);
    await client.close();
  });

  it("follows native assembly pages and rejects non-advancing cursors", async () => {
    const { client, producer } = await fixture();
    producer.overrideCall = (name, args): JsonValue | undefined =>
      name === "disasm"
        ? {
            asm: {
              name: "main",
              start_ea: "0x1000",
              lines: `main (.text @ 0x1000):\n${args.offset === 0 ? "1000  nop" : "1001  ret"}`,
            },
            cursor: args.offset === 0 ? { next: 1 } : { done: true },
          }
        : undefined;
    const result = await client.execute("procedure_assembly", {
      procedure: "main",
    });
    expect(result.ok && result.value.result).toBe("0x1000: nop\n0x1001: ret");
    producer.overrideCall = (name) =>
      name === "find_regex" ? { matches: [], cursor: { next: 0 } } : undefined;
    expect((await client.execute("list_strings", {})).ok).toBe(false);
    await client.close();
  });
});
