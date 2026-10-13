import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AngrProvider } from "../../src/angr/AngrProvider.js";
import { AngrSessionClient } from "../../src/angr/AngrSessionClient.js";
import { AnalysisProtocolError } from "../../src/domain/analysisErrorCore.js";
import { readAngrConfiguration } from "../../src/angr/AngrConfiguration.js";
import { createAngrTarget, RecordingAngrMcp } from "../fixtures/angrMcp.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { parseConfig } from "../../src/config/parseConfig.js";
import { functionDossierSchema } from "../../src/domain/hopperValues.js";
import { angrLoadOptions } from "../../src/angr/AngrProtocolValues.js";
import type { BinaryTarget } from "../../src/domain/binaryTargetTypes.js";

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

describe("angr provider composition", () => {
  it("discovers without connecting and binds one owned project per session", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const config = parseConfig({ REA_ANGR_PYTHON: process.execPath });
    if (!config.ok) throw config.error;
    const producer = new RecordingAngrMcp(target);
    const provider = new AngrProvider(config.value, {}, () => producer);
    expect(provider.inspectAvailability()).toMatchObject({
      status: "available",
      diagnostics: { live_connection_probed: false },
    });
    const session = createTestBinarySession(provider);
    expect((await session.open(target.path)).ok).toBe(true);
    expect(producer.connects).toBe(0);
    const first = await session.execute("procedure_pseudo_code", {
      procedure: "main",
    });
    expect(first.ok && first.value.result).toContain("42");
    expect(producer.connects).toBe(1);
    expect(
      producer.calls
        .map(({ name }) => name)
        .filter((name) => name !== "get_decompilation_flavor")
        .slice(0, 4),
    ).toEqual([
      "load_binary",
      "get_cfg",
      "get_function_info",
      "decompile_function",
    ]);
    const dossier = await session.execute("analyze_function", {
      procedure: "0x1000",
    });
    if (!dossier.ok) throw dossier.error;
    const parsed = functionDossierSchema.parse(dossier.value.result);
    expect(parsed.procedure.body).toMatchObject({
      available: true,
      ranges: [{ start: "0x1000", end: "0x101f" }],
      total_bytes: 32,
      non_contiguous: false,
    });
    expect(parsed.assembly).toEqual(["0x1000: call 0x2000", "0x1010: ret"]);
    expect(parsed.callers.map(({ name }) => name)).toEqual(["helper"]);
    expect(parsed.callees.map(({ name }) => name)).toEqual(["puts"]);
    expect(parsed.callees[0]?.classification).toMatchObject({
      external: true,
      thunk: true,
    });
    expect(dossier.value.relationshipCoverage?.status).toBe("partial");
    // The call graph is fetched once per session.
    await session.execute("procedure_callers", { procedure: "main" });
    expect(
      producer.calls.filter(({ name }) => name === "get_callgraph"),
    ).toHaveLength(1);
    const closed = await session.close();
    expect(closed.ok).toBe(true);
    expect(producer.openProjects.size).toBe(0);
    expect(producer.closes).toBe(1);
  });
});

describe("angr session client boundaries", () => {
  it("reports caller selectors angr cannot resolve as invalid input", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const client = new AngrSessionClient(
      configuration(),
      target,
      new RecordingAngrMcp(target),
    );
    try {
      const missing = await client.execute("procedure_address", {
        procedure: "absent",
      });
      expect(missing.ok).toBe(false);
      if (!missing.ok) expect(missing.error._tag).toBe("AnalysisInputError");
      const provided = await client.execute(
        "procedure_address",
        { procedure: "absent" },
        { selectorOrigin: "provider" },
      );
      expect(provided.ok).toBe(false);
      if (!provided.ok)
        expect(provided.error._tag).toBe("AnalysisProtocolError");
      const found = await client.execute("procedure_address", {
        procedure: "helper",
      });
      expect(found.ok && found.value.result).toBe("0x1040");
    } finally {
      await client.close();
    }
  });
  it("verifies target identity by digest, or by path on a digest-less angr", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    // A matching digest proves identity even when the server's path differs.
    const otherPath = new RecordingAngrMcp(target);
    otherPath.loadedPath = `${target.path}.container-view`;
    const client = new AngrSessionClient(configuration(), target, otherPath);
    expect((await client.execute("list_procedures", {})).ok).toBe(true);
    await client.close();

    const wrongDigest = new RecordingAngrMcp(target);
    wrongDigest.loadedSha256 = "f".repeat(64);
    const client2 = new AngrSessionClient(configuration(), target, wrongDigest);
    const rejected = await client2.execute("list_procedures", {});
    expect(rejected.ok).toBe(false);
    if (!rejected.ok) expect(rejected.error.message).toContain("SHA-256");
    expect((await client2.close()).ok).toBe(true);
    expect(wrongDigest.openProjects.size).toBe(0);
    expect(wrongDigest.closes).toBe(1);

    const legacy = new RecordingAngrMcp(target);
    legacy.loadedSha256 = undefined;
    const client3 = new AngrSessionClient(configuration(), target, legacy);
    const accepted = await client3.execute("list_procedures", {});
    if (!accepted.ok) throw accepted.error;
    expect(accepted.value.limitations).toContainEqual(
      expect.stringContaining("verified by path"),
    );
    await client3.close();

    const legacyOtherPath = new RecordingAngrMcp(target);
    legacyOtherPath.loadedSha256 = undefined;
    legacyOtherPath.loadedPath = `${target.path}.other`;
    const client4 = new AngrSessionClient(
      configuration(),
      target,
      legacyOtherPath,
    );
    const result = await client4.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("share this host");
    await client4.close();
  });
  it("refuses a server that lacks the required tools without calling it", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const limited = new RecordingAngrMcp(target);
    limited.tools = ["load_binary"];
    const client = new AngrSessionClient(configuration(), target, limited);
    const missing = await client.execute("list_procedures", {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("missing tools");
    await client.close();
    expect(limited.calls).toHaveLength(0);
    expect(limited.closes).toBe(1);
  });
});

describe("angr session client degradation and teardown", () => {
  it("omits call-graph edges to unlisted functions and reports them", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const producer = new RecordingAngrMcp(target);
    producer.overrideCall = (name) =>
      name === "get_callgraph"
        ? {
            project_id: "p1",
            node_count: 1,
            edge_count: 2,
            nodes: [{ address: "0x1000", name: "main", is_plt: false }],
            edges: [
              { from: "0x1000", to: "0x2000" },
              { from: "0x9000", to: "0x1000" },
            ],
          }
        : undefined;
    const client = new AngrSessionClient(configuration(), target, producer);
    try {
      const callees = await client.execute("procedure_callees", {
        procedure: "main",
      });
      if (!callees.ok) throw callees.error;
      expect(callees.value.result).toEqual([]);
      expect(callees.value.relationshipCoverage).toMatchObject({
        status: "partial",
        limitations: expect.arrayContaining([
          expect.stringContaining("0x2000"),
        ]),
      });
      const callers = await client.execute("procedure_callers", {
        procedure: "main",
      });
      if (!callers.ok) throw callers.error;
      expect(callers.value.limitations).toContainEqual(
        expect.stringContaining("0x9000"),
      );
    } finally {
      await client.close();
    }
  });
  it("drains cancellation and retains partial Evidence from completed replies", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const producer = new RecordingAngrMcp(target);
    const controller = new AbortController();
    producer.beforeCall = async (name) => {
      if (name === "decompile_function") controller.abort();
    };
    const client = new AngrSessionClient(configuration(), target, producer);
    try {
      const result = await client.execute(
        "analyze_function",
        { procedure: "main" },
        { signal: controller.signal },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error._tag).toBe("AnalysisCancelledError");
        const partial = result.error.partialObservation;
        expect(partial).toBeDefined();
        expect(JSON.stringify(partial)).toContain('"tool":"get_basic_blocks"');
      }
    } finally {
      await client.close();
    }
  });
  it("ends an owned server when its project cannot be closed, but retains an attached one", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const owned = new RecordingAngrMcp(target);
    owned.overrideCall = (name) =>
      name === "close_project"
        ? { project_id: "other", closed: true }
        : undefined;
    const client = new AngrSessionClient(configuration(), target, owned);
    await client.execute("list_procedures", {});
    expect((await client.close()).ok).toBe(true);
    expect(owned.closes).toBe(1);

    const attached = new RecordingAngrMcp(target);
    attached.overrideCall = owned.overrideCall;
    const client2 = new AngrSessionClient(
      {
        ...configuration(),
        url: "http://127.0.0.1:8000/mcp",
        headers: {},
        mode: "attached",
      } as never,
      target,
      attached,
    );
    await client2.execute("list_procedures", {});
    const closed = await client2.close();
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.error.cleanupIncomplete).toBe(true);
      expect(closed.error.cleanupResources).toEqual(["angr project p1"]);
    }
    expect(attached.closes).toBe(0);
    delete attached.overrideCall;
    expect((await client2.close()).ok).toBe(true);
    expect(attached.openProjects.size).toBe(0);
    expect(attached.closes).toBe(1);
  });
});

describe("angr loader options and regex search", () => {
  it("carries a universal slice or raw image selection to load_binary", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    expect(angrLoadOptions(target)).toEqual({});
    const universal: BinaryTarget = {
      ...target,
      format: "mach-o-universal",
      architecture: "arm64",
      availableArchitectures: ["arm64", "x86_64"],
      universalSlice: { offset: 0x4000, size: 0x1000 },
    };
    expect(angrLoadOptions(universal)).toEqual({ arch: "aarch64" });
    const raw: BinaryTarget = {
      ...target,
      format: "raw-binary",
      architecture: "arm",
      availableArchitectures: ["arm"],
      entryPoint: "0x8000000",
      entryPointSource: "0x8000000",
    };
    expect(angrLoadOptions(raw)).toEqual({
      backend: "blob",
      arch: "armel",
      base_address: "0x8000000",
      entry_point: "0x8000000",
    });
    const producer = new RecordingAngrMcp(raw);
    const client = new AngrSessionClient(configuration(), raw, producer);
    try {
      expect((await client.execute("list_procedures", {})).ok).toBe(true);
      expect(producer.calls[0]).toMatchObject({
        name: "load_binary",
        args: { binary_path: raw.path, backend: "blob", arch: "armel" },
      });
    } finally {
      await client.close();
    }
    const legacy = new RecordingAngrMcp(raw);
    legacy.overrideCall = (name) => {
      if (name === "load_binary")
        throw new AnalysisProtocolError(
          "angr MCP tool failed: 1 validation error for call[load_binary]\nbackend\n  Unexpected keyword argument",
        );
      return undefined;
    };
    const client2 = new AngrSessionClient(configuration(), raw, legacy);
    const result = await client2.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok)
      expect(result.error.message).toContain("does not accept loader options");
    await client2.close();
  });
  it("matches regex searches in a cancellable worker and rejects bad patterns as input", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const client = new AngrSessionClient(
      configuration(),
      target,
      new RecordingAngrMcp(target),
    );
    try {
      const names = await client.execute("search_procedures", {
        pattern: "^(main|helper)$",
        mode: "regex",
      });
      if (!names.ok) throw names.error;
      expect(names.value.result).toEqual([
        { address: "0x1000", value: "main" },
        { address: "0x1040", value: "helper" },
      ]);
      const strings = await client.execute("search_strings", {
        pattern: "user\\w+:",
        mode: "regex",
        case_sensitive: true,
      });
      if (!strings.ok) throw strings.error;
      expect(strings.value.result).toEqual([]);
      const insensitive = await client.execute("search_strings", {
        pattern: "user\\w+:",
        mode: "regex",
      });
      if (!insensitive.ok) throw insensitive.error;
      expect(insensitive.value.result).toEqual([
        { address: "0x3000", value: "Username: " },
      ]);
      const invalid = await client.execute("search_procedures", {
        pattern: "(",
        mode: "regex",
      });
      expect(invalid.ok).toBe(false);
      if (!invalid.ok) expect(invalid.error._tag).toBe("AnalysisInputError");
    } finally {
      await client.close();
    }
  });
});
