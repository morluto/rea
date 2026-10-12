import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AngrProvider } from "../../src/angr/AngrProvider.js";
import { AngrSessionClient } from "../../src/angr/AngrSessionClient.js";
import { readAngrConfiguration } from "../../src/angr/AngrConfiguration.js";
import { createAngrTarget, RecordingAngrMcp } from "../fixtures/angrMcp.js";
import { createTestBinarySession } from "../fixtures/binarySession.js";
import { parseConfig } from "../../src/config/parseConfig.js";
import { functionDossierSchema } from "../../src/domain/hopperValues.js";

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
    expect(producer.calls.map(({ name }) => name).slice(0, 4)).toEqual([
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
  it("refuses a server that loaded a different file or lacks the required tools", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const wrongFile = new RecordingAngrMcp(target);
    wrongFile.loadedPath = `${target.path}.other`;
    const client = new AngrSessionClient(configuration(), target, wrongFile);
    const result = await client.execute("list_procedures", {});
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.message).toContain("instead of");
    expect((await client.close()).ok).toBe(true);
    expect(wrongFile.openProjects.size).toBe(0);

    const limited = new RecordingAngrMcp(target);
    limited.tools = ["load_binary"];
    const client2 = new AngrSessionClient(configuration(), target, limited);
    const missing = await client2.execute("list_procedures", {});
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error.message).toContain("missing tools");
    await client2.close();
    expect(limited.calls).toHaveLength(0);
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
  it("retains the upstream project for retry when close cannot be verified", async () => {
    const { root, target } = await createAngrTarget();
    roots.push(root);
    const producer = new RecordingAngrMcp(target);
    producer.overrideCall = (name) =>
      name === "close_project"
        ? { project_id: "other", closed: true }
        : undefined;
    const client = new AngrSessionClient(configuration(), target, producer);
    await client.execute("list_procedures", {});
    const closed = await client.close();
    expect(closed.ok).toBe(false);
    if (!closed.ok) {
      expect(closed.error.cleanupIncomplete).toBe(true);
      expect(closed.error.cleanupResources).toEqual(["angr project p1"]);
    }
    delete producer.overrideCall;
    expect((await client.close()).ok).toBe(true);
    expect(producer.openProjects.size).toBe(0);
  });
});
