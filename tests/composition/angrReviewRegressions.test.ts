import { rm } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { AngrSessionClient } from "../../src/angr/AngrSessionClient.js";
import { readAngrConfiguration } from "../../src/angr/AngrConfiguration.js";
import { ANGR_PROVIDER_IDENTITY } from "../../src/angr/AngrProviderCapabilities.js";
import { createAnalysisProfile } from "../../src/domain/analysisProfile.js";
import { AnalysisProtocolError } from "../../src/domain/analysisErrorCore.js";
import { createAngrTarget, RecordingAngrMcp } from "../fixtures/angrMcp.js";

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
