import { err, ok } from "../domain/result.js";
import type { GhidraJavaObservation } from "./GhidraJavaProbe.js";
import { describe, expect, it } from "vitest";

import {
  createDeferred,
  createTestBinarySession,
} from "../../tests/fixtures/binarySession.js";
import { awaitAcknowledgement } from "../../tests/fixtures/lifecycleAcknowledgement.js";
import { parseConfig } from "../config/parseConfig.js";
import type { AnalysisOperation } from "../ports/AnalysisProvider.js";
import type { BinaryTarget } from "../domain/binaryTargetTypes.js";
import { functionDossierSchema } from "../domain/native/functionDossier.js";
import { createAnalysisProfile } from "../domain/analysisProfile.js";
import { ghidraFunctionDossier } from "../domain/ghidraValues.fixture.js";
import { silentLogger } from "../logger.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { ghidraProducerIdentity } from "./GhidraProducerIdentity.js";
import type { ProducerIdentity } from "../filesystem/ProducerIdentity.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";
import type { RelationshipCoverage } from "../domain/relationshipCoverage.js";

const TARGET: BinaryTarget = {
  path: "/tmp/ghidra-cache-fixture",
  sha256: "a".repeat(64),
  kind: "executable",
  format: "elf",
  architecture: "x86_64",
  availableArchitectures: ["x86_64"],
};

// Exercise the real provider descriptors, profile, input/output projection and
// session cache; only the installed Ghidra process is replaced at its seam.
const fixture = (version = "12.2", coverage?: RelationshipCoverage) => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: "/opt/ghidra" });
  if (!config.ok) throw config.error;
  const calls: string[] = [];
  let name = "original";
  let decompilerFailed = false;
  const { promise: cancellationReady, resolve: cancelStarted } =
    createDeferred<void>();
  const provider = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    {
      platform: "linux",
      architecture: "x64",
      readText: () =>
        `application.version=${version}\napplication.java.min=25\n`,
      executable: () => true,
      probeJava: () =>
        ok<GhidraJavaObservation>({
          osArch: "amd64",
          osName: "Linux",
          version: "25.0.1",
          major: 25,
          home: "/usr/lib/jvm/jdk-25",
          bits: 64,
          runtime: "jdk",
        }),
    },
    (options) => ({
      start: async () =>
        ok({
          name: "REA Ghidra bridge",
          run_id: "11111111-1111-4111-8111-111111111111",
          profile_digest: options.profileDigest,
          provider: { id: "ghidra", version },
          read_only: false,
          analysis_complete: true,
          analysis_timed_out: false,
          capabilities: [...GHIDRA_SESSION_CAPABILITIES],
          target: {
            name: "fixture",
            language_id: "x86:LE:64:default",
            compiler_spec_id: "gcc",
            image_base: "0x1000",
            default_address_space: "ram",
            sha256: TARGET.sha256,
          },
        }),
      callTool: async (operation, parameters, requestOptions) => {
        calls.push(operation);
        if (requestOptions?.signal !== undefined) {
          const signal = requestOptions.signal;
          if (!signal.aborted) {
            await new Promise<void>((resolve) => {
              signal.addEventListener("abort", () => resolve(), { once: true });
              cancelStarted();
            });
          }
          // Active cancellation discards Ghidra's ephemeral annotations; the
          // next request reimports the original artifact under the same profile.
          name = "original";
          return err(new GhidraSessionError("cancelled", "Cancelled"));
        }
        if (operation === "annotate_native_function") {
          if (typeof parameters.name !== "string")
            throw new Error("Expected an annotation name");
          name = parameters.name;
        }
        if (operation === "read_binary_inventory_summary")
          return ok({
            document: "fixture",
            segments: [],
            procedure_count: 0,
            string_count: 0,
          });
        const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
        dossier.procedure.name = name;
        dossier.pseudocode = `void ${name}() {}`;
        if (decompilerFailed) {
          dossier.pseudocode = "";
          dossier.facet_availability = {
            ...dossier.facet_availability,
            pseudocode: {
              available: false,
              reason: "Injected backend failure",
            },
          };
        }
        if (operation === "annotate_native_function")
          return ok({
            annotations: {
              address: dossier.procedure.address,
              name,
              comment: null,
              inline_comment: null,
            },
            dossier,
            effects: {
              scope: "session-analysis-database",
              source_bytes_modified: false,
              persists_after_close: false,
            },
          });
        const value =
          operation === "procedure_pseudo_code" ? dossier.pseudocode : dossier;
        return ok(
          operation === "procedure_pseudo_code" ||
            operation === "analyze_function"
            ? {
                value,
                limitations: [],
                ...(operation === "analyze_function" && decompilerFailed
                  ? { cache_policy: "live" }
                  : {}),
                ...(operation === "analyze_function" && coverage !== undefined
                  ? { relationship_coverage: coverage }
                  : {}),
              }
            : value,
        );
      },
      close: async () => ok(null),
    }),
  );
  return {
    calls,
    cancellationReady,
    setDecompilerFailed: (failed: boolean) => {
      decompilerFailed = failed;
    },
    session: createTestBinarySession(provider),
  };
};

const open = async (session: ReturnType<typeof fixture>["session"]) => {
  const preview = await session.previewTarget(TARGET);
  if (!preview.ok) throw preview.error;
  expect((await session.openResolvedTarget(preview.value)).ok).toBe(true);
};

/**
 * Windows must admit the native source with a live operation before it may
 * replay an imported query. Use a different query so the imported entry is
 * still the one under test.
 */
const admitWindowsNativeSource = async (
  replay: ReturnType<typeof fixture>,
  operation: AnalysisOperation,
): Promise<AnalysisOperation | undefined> => {
  if (process.platform !== "win32") return undefined;
  const admission =
    operation === "read_binary_inventory_summary"
      ? {
          operation: "analyze_function" as const,
          parameters: { procedure: "0xlive" },
        }
      : {
          operation: "read_binary_inventory_summary" as const,
          parameters: {},
        };
  const admitted = await replay.session.execute(
    admission.operation,
    admission.parameters,
  );
  if (!admitted.ok) throw admitted.error;
  expect(replay.calls).toEqual([admission.operation]);
  return admission.operation;
};

describe("Ghidra relationship coverage replay", () => {
  it("retains degraded Evidence without replaying transient failures after recovery or import", async () => {
    const initial = fixture();
    await open(initial.session);
    initial.setDecompilerFailed(true);
    const parameters = { procedure: "0x1000" };
    const degraded = await initial.session.execute(
      "analyze_function",
      parameters,
    );
    if (!degraded.ok) throw degraded.error;
    const snapshot = initial.session.exportAnalysisSnapshot();
    if (!snapshot.ok) throw snapshot.error;
    expect(snapshot.value.entries).toEqual([]);
    expect(snapshot.value.evidence_bundle.records).toHaveLength(1);

    initial.setDecompilerFailed(false);
    const recovered = await initial.session.execute(
      "analyze_function",
      parameters,
    );
    if (!recovered.ok) throw recovered.error;
    expect(
      functionDossierSchema.parse(recovered.value.result).pseudocode,
    ).not.toBe("");
    expect(
      (await initial.session.execute("analyze_function", parameters)).ok,
    ).toBe(true);
    expect(initial.calls).toEqual([
      "analyze_function",
      "analyze_function",
      "analyze_function",
    ]);
    await initial.session.close();

    const replay = fixture();
    expect(replay.session.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    await open(replay.session);
    const imported = await replay.session.execute(
      "analyze_function",
      parameters,
    );
    if (!imported.ok) throw imported.error;
    expect(
      functionDossierSchema.parse(imported.value.result).pseudocode,
    ).not.toBe("");
    expect(replay.calls).toEqual(["analyze_function"]);
    expect(replay.session.exportEvidenceBundle().records).toHaveLength(2);
    await replay.session.close();
  });

  it.each([
    undefined,
    { status: "complete", diagnostics: ["Resolved static references only."] },
    { status: "unknown", reason: "Relationship inventory was unavailable." },
    {
      status: "partial",
      limitations: ["Missing callers."],
      limited_directions: ["callers"],
    },
  ] satisfies (RelationshipCoverage | undefined)[])(
    "preserves relationship coverage %j as historical Evidence while reobserving new calls",
    async (coverage) => {
      const initial = fixture("12.2", coverage);
      await open(initial.session);
      const parameters = { procedure: "0x1000" };
      for (let i = 0; i < 2; i++) {
        const execution = await initial.session.execute(
          "analyze_function",
          parameters,
        );
        if (!execution.ok) throw execution.error;
        expect(execution.value.relationshipCoverage).toEqual(coverage);
      }
      expect(initial.calls).toEqual(["analyze_function", "analyze_function"]);
      const snapshot = initial.session.exportAnalysisSnapshot();
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.entries).toEqual([]);
      expect(
        snapshot.value.evidence_bundle.records[0]?.relationship_coverage,
      ).toEqual(coverage ?? null);
      await initial.session.close();
      const liveCoverage: RelationshipCoverage = {
        status: "unknown",
        reason: "Current observation after import",
      };
      const replay = fixture("12.2", liveCoverage);
      expect(replay.session.importAnalysisSnapshot(snapshot.value).ok).toBe(
        true,
      );
      await open(replay.session);
      const admittedOperation = await admitWindowsNativeSource(
        replay,
        "analyze_function",
      );
      const execution = await replay.session.execute(
        "analyze_function",
        parameters,
      );
      if (!execution.ok) throw execution.error;
      expect(execution.value.relationshipCoverage ?? undefined).toEqual(
        liveCoverage,
      );
      expect(execution.value.limitations.join(" ")).not.toContain(
        "local REA analysis snapshot",
      );
      expect(replay.calls).toEqual([
        ...(admittedOperation === undefined ? [] : [admittedOperation]),
        "analyze_function",
      ]);
      await replay.session.close();
    },
  );
});

describe("Ghidra snapshot profile admission", () => {
  it.each([
    {
      change: "an edited bridge script",
      producer: (current: ProducerIdentity) => ({
        ...current,
        sources_sha256: "0".repeat(64),
      }),
    },
    {
      change: "another REA release",
      producer: (current: ProducerIdentity) => ({
        ...current,
        rea_version: "0.0.0-earlier",
      }),
    },
    { change: "no producer identity", producer: () => undefined },
  ])(
    "refuses snapshots from $change without a revision marker",
    async ({ producer }) => {
      const initial = fixture();
      await open(initial.session);
      const snapshot = initial.session.exportAnalysisSnapshot();
      if (!snapshot.ok) throw snapshot.error;
      await initial.session.close();
      const profile = snapshot.value.binding.analysis_profile;
      expect(profile.parameters.producer).toEqual(ghidraProducerIdentity());
      const prior = producer(ghidraProducerIdentity());
      const legacy = {
        ...snapshot.value,
        binding: {
          ...snapshot.value.binding,
          analysis_profile: createAnalysisProfile(profile.provider, {
            ...Object.fromEntries(
              Object.entries(profile.parameters).filter(
                ([key]) => key !== "producer",
              ),
            ),
            ...(prior === undefined ? {} : { producer: prior }),
          }),
        },
      };
      const replay = fixture();
      const imported = replay.session.importAnalysisSnapshot(legacy);
      if (!imported.ok) throw imported.error;
      expect(await replay.session.previewTarget(TARGET)).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceIntegrityError" },
      });
      expect(replay.calls).toEqual([]);
      await replay.session.close();
    },
  );
});

describe("Ghidra snapshot cache", () => {
  it("replays inventory and document-scoped pseudocode through one snapshot", async () => {
    const queries = [
      {
        operation: "read_binary_inventory_summary",
        parameters: {},
        result: {
          document: "fixture",
          segments: [],
          segment_count: 0,
          procedure_count: 0,
          string_count: 0,
        },
      },
      {
        operation: "procedure_pseudo_code",
        parameters: { procedure: "0x1000", document: "fixture" },
        result: "void original() {}",
      },
    ] as const;
    const expectCachedQueries = async (
      session: ReturnType<typeof fixture>["session"],
    ) => {
      for (const { operation, parameters, result } of queries) {
        const cached = await session.execute(operation, parameters);
        if (!cached.ok) throw cached.error;
        expect(cached.value.result).toEqual(result);
        expect(cached.value.limitations).toContainEqual(
          expect.stringContaining("local REA analysis snapshot"),
        );
      }
    };

    const initial = fixture();
    await open(initial.session);
    for (const { operation, parameters, result } of queries) {
      const live = await initial.session.execute(operation, parameters);
      if (!live.ok) throw live.error;
      expect(live.value.result).toEqual(result);
    }
    await expectCachedQueries(initial.session);
    expect(initial.calls).toEqual(queries.map(({ operation }) => operation));
    const snapshot = initial.session.exportAnalysisSnapshot();
    if (!snapshot.ok) throw snapshot.error;
    expect(snapshot.value.entries).toHaveLength(queries.length);
    await initial.session.close();

    const replay = fixture();
    expect(replay.session.importAnalysisSnapshot(snapshot.value).ok).toBe(true);
    await open(replay.session);
    const admittedOperation = await admitWindowsNativeSource(
      replay,
      queries[0].operation,
    );
    await expectCachedQueries(replay.session);
    expect(replay.calls).toEqual(
      admittedOperation === undefined ? [] : [admittedOperation],
    );
    await replay.session.close();

    const changed = fixture("12.3");
    expect(changed.session.importAnalysisSnapshot(snapshot.value).ok).toBe(
      true,
    );
    expect(await changed.session.previewTarget(TARGET)).toMatchObject({
      ok: false,
      error: {
        _tag: "EvidenceIntegrityError",
        bindingMismatch: {
          provider: {
            snapshot: { version: "12.2" },
            selected: { version: "12.3" },
          },
        },
      },
    });
    expect(changed.calls).toEqual([]);
    await changed.session.close();
  });

  it("keeps annotation-dependent reads live after cancellation reimports the original artifact", async () => {
    const { session, calls, cancellationReady } = fixture();
    await open(session);
    expect(
      (await session.execute("read_binary_inventory_summary", {})).ok,
    ).toBe(true);
    const parameters = { procedure: "0x1000", document: "fixture" };
    expect(
      await session.execute("procedure_pseudo_code", parameters),
    ).toMatchObject({
      ok: true,
      value: { result: "void original() {}" },
    });
    expect(
      (
        await session.execute("annotate_native_function", {
          procedure: "0x1000",
          name: "renamed",
        })
      ).ok,
    ).toBe(true);
    for (let index = 0; index < 2; index += 1) {
      expect(
        (await session.execute("read_binary_inventory_summary", {})).ok,
      ).toBe(true);
      expect(
        await session.execute("procedure_pseudo_code", parameters),
      ).toMatchObject({
        ok: true,
        value: { result: "void renamed() {}" },
      });
    }
    expect(session.exportAnalysisSnapshot().ok).toBe(false);
    const controller = new AbortController();
    const cancelled = session.execute(
      "analyze_function",
      { procedure: "0x2000" },
      { signal: controller.signal },
    );
    try {
      await awaitAcknowledgement(cancellationReady, cancelled, "Ghidra call");
    } finally {
      controller.abort();
      await Promise.allSettled([cancelled]);
    }
    expect(await cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    for (let index = 0; index < 2; index += 1) {
      expect(
        (await session.execute("read_binary_inventory_summary", {})).ok,
      ).toBe(true);
      expect(
        await session.execute("procedure_pseudo_code", parameters),
      ).toMatchObject({
        ok: true,
        value: { result: "void original() {}" },
      });
    }
    expect(
      calls.filter(
        (operation) => operation === "read_binary_inventory_summary",
      ),
    ).toHaveLength(5);
    expect(
      calls.filter((operation) => operation === "procedure_pseudo_code"),
    ).toHaveLength(5);
    expect(session.exportAnalysisSnapshot().ok).toBe(false);
    await session.close();
  });
});
