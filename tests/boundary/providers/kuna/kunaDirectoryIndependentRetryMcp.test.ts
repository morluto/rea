import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, expect, it as test, vi } from "vitest";
import { AnalysisProviderRegistry } from "../../../../src/application/binary/AnalysisProviderRegistry.js";
import { composeBinarySession } from "../../../../src/application/binary/BinarySessionComposition.js";
import { parseEvidence } from "../../../../src/domain/evidence.js";
import { KunaProvider } from "../../../../src/kuna/KunaProvider.js";
import { elfNoteFixture } from "../../../../src/native/elf/ElfNotes.fixture.js";
import { createApplicationMcpHarness } from "../../../fixtures/applicationMcpHarness.js";
import { advertisedMcpToolSchemas } from "../../../fixtures/advertisedMcpTool.js";
import { createMcpSchemaValidation } from "../../../fixtures/mcpSchemaValidation.js";
import { awaitAcknowledgement } from "../../../fixtures/lifecycleAcknowledgement.js";
import { createTestTempDirectory } from "../../../fixtures/temporaryDirectory.js";
import { fakeKunaCalls, writeFakeKuna } from "./fakeKuna.js";
import { FUNCTIONS, unprovenCleanupLauncher } from "./kunaSessionFixture.js";

const it = test.skipIf(process.platform === "win32");
const schemas = createMcpSchemaValidation();
afterAll(() => schemas.clear());

it.each(["compact", "full"] as const)(
  "guides resume and retries only reported project failures (%s)",
  async (profile) => {
    const root = await createTestTempDirectory("rea-directory-independent-");
    const kuna = await writeFakeKuna(root, { functions: FUNCTIONS });
    const target = join(root, "program");
    const output = join(root, "output");
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
      await call("procedure_assembly", { procedure: "main" });
      const initial = parseEvidence(
        await call("decompile_all", { output_directory: output }),
      );
      expect(initial.normalized_result).toMatchObject({
        counts: { written: 2, failed: 2 },
        failures: expect.arrayContaining([
          expect.objectContaining({
            address: "0x1080",
            message: expect.stringContaining("resume this export"),
          }),
          expect.objectContaining({
            address: "0x2000",
            message: "The provider returned null pseudocode for this function.",
          }),
        ]),
      });
      const evidence = parseEvidence(
        await call("decompile_all", {
          output_directory: output,
          resume: true,
          retry_failed: "independent_fresh",
        }),
      );
      expect(evidence.normalized_result).toMatchObject({
        counts: { written: 1, failed: 1, skipped: 2 },
      });
      const index = JSON.parse(
        await readFile(join(output, "decompile-index.json"), "utf8"),
      ) as {
        functions: Array<{
          address: string;
          status: string;
          provider_source?: unknown;
        }>;
      };
      expect(
        index.functions.find((item) => item.address === "0x1080"),
      ).toMatchObject({
        status: "written",
        provider_source: {
          status: "reported",
          source: { kind: "single-function-decompile" },
        },
      });
      expect(
        index.functions.find((item) => item.address === "0x2000"),
      ).toMatchObject({
        status: "failed",
        pseudocode_absence: { kind: "not-in-export" },
        limitations: expect.arrayContaining([
          "Independent retry was not attempted because the provider did not report a function failure for this observation.",
        ]),
      });
      const journal = (
        await readFile(join(output, "decompile-journal.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as {
              address?: string;
              status?: string;
              provider_source?: unknown;
            },
        );
      expect(journal.filter((row) => row.address === "0x1080")).toEqual([
        expect.objectContaining({
          status: "failed",
          pseudocode_absence: expect.objectContaining({
            kind: "provider-failure",
          }),
          failure: expect.objectContaining({
            message: expect.stringContaining("resume this export"),
          }),
        }),
        expect.objectContaining({
          status: "failed",
          pseudocode_absence: expect.objectContaining({
            kind: "provider-failure",
          }),
          provider_source: {
            status: "reported",
            source: expect.objectContaining({ kind: "file-range" }),
          },
        }),
        expect.objectContaining({
          status: "written",
          provider_source: {
            status: "reported",
            source: { kind: "single-function-decompile" },
          },
        }),
      ]);
      expect(
        (await fakeKunaCalls(kuna))
          .filter(({ argv }) => argv[0] === "decompile")
          .map(({ argv }) => argv[2]),
      ).toEqual(["0x1080"]);
    } finally {
      await harness.close();
      const closed = await provider.closeOwnedResources();
      if (!closed.ok) throw closed.error;
    }
  },
);

it("retains the project failure when the independent retry times out", async () => {
  const root = await createTestTempDirectory(
    "rea-directory-independent-timeout-",
  );
  const kuna = await writeFakeKuna(root, {
    functions: FUNCTIONS,
    decompile: "hang",
  });
  const target = join(root, "program");
  const output = join(root, "output");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const provider = new KunaProvider(
    {
      REA_KUNA_COMMAND: kuna,
      REA_KUNA_CACHE_DIR: join(root, "cache"),
      REA_KUNA_TIMEOUT_MS: "300",
    },
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
    await call("procedure_assembly", { procedure: "main" });
    const evidence = parseEvidence(
      await call("decompile_all", {
        output_directory: output,
        address_start: "0x1080",
        address_end: "0x1080",
        retry_failed: "independent_fresh",
      }),
    );
    expect(evidence.normalized_result).toMatchObject({
      counts: { written: 0, failed: 1 },
      failures: [{ address: "0x1080", code: "deadline" }],
    });
    const journal = (
      await readFile(join(output, "decompile-journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map(
        (line) =>
          JSON.parse(line) as {
            address?: string;
            status?: string;
            failure?: { code: string };
          },
      );
    const attempts = journal.filter((row) => row.address === "0x1080");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      status: "failed",
      pseudocode_absence: { kind: "provider-failure" },
    });
    expect(attempts[1]).toMatchObject({
      status: "failed",
      failure: { code: "deadline" },
    });
  } finally {
    await harness.close();
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});

it("retains the project failure when cancellation stops the independent retry", async () => {
  const root = await createTestTempDirectory(
    "rea-directory-independent-cancel-",
  );
  const kuna = await writeFakeKuna(root, {
    functions: FUNCTIONS,
    decompile: "hang",
  });
  const target = join(root, "program");
  const output = join(root, "output");
  await writeFile(target, elfNoteFixture({ bits: 64, type: 2 }));
  const provider = new KunaProvider(
    {
      REA_KUNA_COMMAND: kuna,
      REA_KUNA_CACHE_DIR: join(root, "cache"),
      REA_KUNA_TIMEOUT_MS: "10000",
    },
    { platform: process.platform },
  );
  const session = composeBinarySession(
    new AnalysisProviderRegistry([provider], "kuna"),
  );
  const harness = await createApplicationMcpHarness({ session });
  const controller = new AbortController();
  let pending: Promise<unknown> | undefined;
  try {
    expect(
      (
        await harness.client.callTool({
          name: "open_binary",
          arguments: { path: target, provider_id: "kuna" },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await harness.client.callTool({
          name: "procedure_assembly",
          arguments: { procedure: "main" },
        })
      ).isError,
    ).not.toBe(true);
    pending = harness.client
      .callTool(
        {
          name: "decompile_all",
          arguments: {
            output_directory: output,
            address_start: "0x1080",
            address_end: "0x1080",
            retry_failed: "independent_fresh",
          },
        },
        { signal: controller.signal, timeout: 15000 },
      )
      .catch(() => undefined);
    const launched = vi.waitFor(
      async () => {
        expect(
          (await fakeKunaCalls(kuna)).some(
            ({ argv }) => argv[0] === "decompile" && argv[2] === "0x1080",
          ),
        ).toBe(true);
      },
      { timeout: 5000, interval: 20 },
    );
    await awaitAcknowledgement(
      launched,
      pending,
      "independent retry launch",
      6000,
    );
    controller.abort();
    await pending;
    expect(
      (await harness.client.callTool({ name: "close_binary", arguments: {} }))
        .isError,
    ).not.toBe(true);
    const journal = (
      await readFile(join(output, "decompile-journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { address?: string; status?: string });
    expect(journal.filter((row) => row.address === "0x1080")).toEqual([
      expect.objectContaining({
        status: "failed",
        pseudocode_absence: expect.objectContaining({
          kind: "provider-failure",
        }),
      }),
    ]);
  } finally {
    controller.abort();
    await pending;
    await harness.close();
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});

it("retains failed attempt and cleanup ownership when retry stop is unproven", async () => {
  const root = await createTestTempDirectory(
    "rea-directory-independent-cleanup-",
  );
  const kuna = await writeFakeKuna(root, {
    functions: FUNCTIONS,
    decompile: "hang",
  });
  const target = join(root, "program");
  const output = join(root, "output");
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
  const harness = await createApplicationMcpHarness({ session });
  try {
    expect(
      (
        await harness.client.callTool({
          name: "open_binary",
          arguments: { path: target, provider_id: "kuna" },
        })
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await harness.client.callTool({
          name: "procedure_assembly",
          arguments: { procedure: "main" },
        })
      ).isError,
    ).not.toBe(true);
    const failed = await harness.client.callTool({
      name: "decompile_all",
      arguments: {
        output_directory: output,
        address_start: "0x1080",
        address_end: "0x1080",
        retry_failed: "independent_fresh",
      },
    });
    expect(failed.isError).toBe(true);
    expect(
      JSON.parse((failed.content[0] as { text: string }).text),
    ).toMatchObject({ error: { code: "cleanup_incomplete" } });
    const journal = (
      await readFile(join(output, "decompile-journal.jsonl"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { address?: string; status?: string });
    expect(journal.filter((row) => row.address === "0x1080")).toEqual([
      expect.objectContaining({
        status: "failed",
        pseudocode_absence: expect.objectContaining({
          kind: "provider-failure",
        }),
      }),
    ]);
    expect(
      (await harness.client.callTool({ name: "close_binary", arguments: {} }))
        .isError,
    ).toBe(true);
    unproven.release();
    expect(
      (await harness.client.callTool({ name: "close_binary", arguments: {} }))
        .isError,
    ).not.toBe(true);
  } finally {
    unproven.release();
    await harness.close();
    const closed = await provider.closeOwnedResources();
    if (!closed.ok) throw closed.error;
  }
});
