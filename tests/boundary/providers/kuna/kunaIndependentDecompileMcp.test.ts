import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it as test } from "vitest";
import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createApplicationMcpHarness } from "../../../fixtures/applicationMcpHarness.js";
import { advertisedMcpToolSchemas } from "../../../fixtures/advertisedMcpTool.js";
import { createMcpSchemaValidation } from "../../../fixtures/mcpSchemaValidation.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import {
  fakeKunaCalls,
  setFakeKunaBehavior,
  writeFakeKuna,
} from "./fakeKuna.js";
import { FUNCTIONS, unprovenCleanupLauncher } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");
const schemas = createMcpSchemaValidation();
afterAll(() => schemas.clear());

it("runs a cold independent request without starting a project export", async () => {
  const root = await createTestTempDirectory("rea-kuna-independent-cold-");
  const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
  const target = join(root, "program");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const provider = new KunaProvider(
    { REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: join(root, "cache") },
    { platform: process.platform },
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider], "kuna"),
  );
  const harness = await createApplicationMcpHarness({ session });
  try {
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await harness.client.callTool({ name, arguments: args });
      expect(result.isError, JSON.stringify(result)).not.toBe(true);
      return result.structuredContent;
    };
    await call("open_binary", { path: target, provider_id: "kuna" });
    const evidence = parseEvidence(
      await call("procedure_pseudo_code", {
        procedure: "main",
        analysis: "independent_fresh",
      }),
    );
    expect(evidence.raw_result).toMatchObject({
      source: { kind: "single-function" },
      project_export: { state: "not-started" },
    });
    const calls = await fakeKunaCalls(kuna);
    expect(calls.filter(({ argv }) => argv[0] === "functions")).toHaveLength(1);
    expect(calls.filter(({ argv }) => argv[0] === "decompile")).toHaveLength(1);
    expect(
      calls.filter(({ argv }) => argv[0] === "decompile-project"),
    ).toHaveLength(0);
    await call("procedure_assembly", { procedure: "main" });
    expect(
      (await fakeKunaCalls(kuna)).filter(
        ({ argv }) => argv[0] === "decompile-project",
      ),
    ).toHaveLength(1);
  } finally {
    await harness.close();
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});

it.each(["compact", "full"] as const)(
  "keeps the failed project observation when an explicit fresh retry succeeds (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-kuna-independent-");
    const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
    const target = join(root, "program");
    await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
    const provider = new KunaProvider(
      { REA_KUNA_COMMAND: kuna, REA_KUNA_CACHE_DIR: join(root, "cache") },
      { platform: process.platform },
    );
    const session = composeBinarySession(
      new AnalysisProviderRegistry([provider], "kuna"),
    );
    const harness = await createApplicationMcpHarness({
      session,
      schemaValidator: schemas,
      serverOptions: {
        environment: {
          ...process.env,
          REA_MCP_INPUT_SCHEMA_PROFILE: profile,
          REA_MCP_OUTPUT_SCHEMA_PROFILE: profile,
        },
      },
    });
    try {
      const call = async (name: string, args: Record<string, unknown>) => {
        const schema = await advertisedMcpToolSchemas(
          harness.client,
          name,
          schemas.assertions,
        );
        const result = await harness.client.callTool(
          { name, arguments: args },
          { toolDefinition: schema.toolDefinition },
        );
        expect(result.isError, JSON.stringify(result)).not.toBe(true);
        expect(
          schema.ajv.validate(schema.outputSchema, result.structuredContent),
          JSON.stringify(schema.ajv.errors),
        ).toBe(true);
        return result.structuredContent;
      };
      await call("open_binary", { path: target, provider_id: "kuna" });
      await call("procedure_assembly", { procedure: "broken" });
      const original = parseEvidence(
        await call("procedure_pseudo_code", { procedure: "broken" }),
      );
      expect(original.normalized_result).toBeNull();
      expect(original.limitations).toEqual(
        expect.arrayContaining([expect.stringContaining("independent_fresh")]),
      );
      const status = (await call("binary_session", { detail: "summary" })) as {
        result: {
          capabilities: Array<{
            groups: Array<{
              operations: string[];
              independent_decompile?: boolean;
            }>;
          }>;
        };
      };
      expect(
        status.result.capabilities
          .flatMap((set) => set.groups)
          .find((group) => group.operations.includes("procedure_pseudo_code")),
      ).toMatchObject({ independent_decompile: true });
      const first = parseEvidence(
        await call("procedure_pseudo_code", {
          procedure: "broken",
          analysis: "independent_fresh",
        }),
      );
      const second = parseEvidence(
        await call("procedure_pseudo_code", {
          procedure: "broken",
          analysis: "independent_fresh",
        }),
      );
      expect(first.normalized_result).toEqual(
        expect.stringContaining("single-function"),
      );
      expect(first.parameters.analysis).toBe("independent_fresh");
      expect(first.evidence_id).not.toBe(original.evidence_id);
      expect(second.evidence_id).toBe(first.evidence_id);
      expect(
        (await fakeKunaCalls(kuna)).filter(
          ({ argv }) => argv[0] === "decompile",
        ),
      ).toHaveLength(2);
      const after = parseEvidence(
        await call("procedure_pseudo_code", { procedure: "broken" }),
      );
      expect(after.normalized_result).toBeNull();
      const bundle = (await call("get_evidence_bundle", {})) as {
        result: { records: Array<{ evidence_id: string }> };
      };
      expect(bundle.result.records.map((record) => record.evidence_id)).toEqual(
        expect.arrayContaining([original.evidence_id, first.evidence_id]),
      );
    } finally {
      await harness.close();
      const closed = await provider.closeOwnedResources();
      if (!closed.ok) throw closed.error;
    }
  },
);

it("retains the independent run slot until an unproven stop is resolved", async () => {
  const root = await createTestTempDirectory("rea-kuna-independent-cleanup-");
  const kuna = await writeFakeKuna(root, {
    functions: FUNCTIONS,
    decompile: "hang",
  });
  const target = join(root, "program");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const unproven = unprovenCleanupLauncher("decompile");
  const provider = new KunaProvider(
    {
      REA_KUNA_COMMAND: kuna,
      REA_KUNA_CACHE_DIR: join(root, "cache"),
      REA_KUNA_TIMEOUT_MS: "300",
    },
    {
      platform: process.platform,
      launcher: unproven.launcher,
      singleFunctionRuns: 1,
    },
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider], "kuna"),
  );
  const harness = await createApplicationMcpHarness({
    session,
    schemaValidator: schemas,
  });
  const caller = new AbortController();
  try {
    const call = (
      name: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ) =>
      harness.client.callTool(
        { name, arguments: args },
        { ...(signal === undefined ? {} : { signal }), timeout: 5000 },
      );
    expect(
      (await call("open_binary", { path: target, provider_id: "kuna" }))
        .isError,
    ).not.toBe(true);
    expect(
      (await call("procedure_assembly", { procedure: "broken" })).isError,
    ).not.toBe(true);
    const first = await call("procedure_pseudo_code", {
      procedure: "broken",
      analysis: "independent_fresh",
    });
    expect(first.isError).toBe(true);
    const failure = JSON.parse((first.content[0] as { text: string }).text) as {
      error: { code: string };
    };
    expect(failure.error.code).toBe("cleanup_incomplete");
    const queued = call(
      "procedure_pseudo_code",
      { procedure: "main", analysis: "independent_fresh" },
      caller.signal,
    ).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(
      (await fakeKunaCalls(kuna)).filter(({ argv }) => argv[0] === "decompile"),
    ).toHaveLength(1);
    caller.abort();
    await queued;
    expect((await call("close_binary", {})).isError).toBe(true);
    unproven.release();
    expect((await call("close_binary", {})).isError).not.toBe(true);
    await setFakeKunaBehavior(kuna, { functions: FUNCTIONS });
    expect(
      (await call("open_binary", { path: target, provider_id: "kuna" }))
        .isError,
    ).not.toBe(true);
    const recovered = await call("procedure_pseudo_code", {
      procedure: "main",
      analysis: "independent_fresh",
    });
    expect(recovered.isError).not.toBe(true);
    expect(
      (await fakeKunaCalls(kuna)).filter(({ argv }) => argv[0] === "decompile"),
    ).toHaveLength(2);
  } finally {
    caller.abort();
    unproven.release();
    await harness.close();
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});
