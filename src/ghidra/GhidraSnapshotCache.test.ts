import { describe, expect, it } from "vitest";

import { createTestBinarySession } from "../../tests/fixtures/binarySession.js";
import { parseConfig } from "../config.js";
import type { BinaryTarget } from "../domain/binaryTarget.js";
import { functionDossierSchema } from "../domain/hopperValues.js";
import { ghidraFunctionDossier } from "../domain/ghidraValues.fixture.js";
import { err, ok } from "../domain/result.js";
import { silentLogger } from "../logger.js";
import { GhidraProvider } from "./GhidraProvider.js";
import { GhidraSessionError } from "./GhidraSessionError.js";
import { GHIDRA_SESSION_CAPABILITIES } from "./GhidraSessionValues.js";

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
const fixture = (version = "12.1.4") => {
  const config = parseConfig({ GHIDRA_INSTALL_DIR: "/opt/ghidra" });
  if (!config.ok) throw config.error;
  const calls: string[] = [];
  let name = "original";
  let cancelStarted: (() => void) | undefined;
  const cancellationReady = new Promise<void>((resolve) => {
    cancelStarted = resolve;
  });
  const provider = new GhidraProvider(
    config.value,
    silentLogger,
    {},
    {
      platform: "linux",
      architecture: "x64",
      readText: () => `application.version=${version}\n`,
      executable: () => true,
      probeJava: () => ({
        version: "21.0.11",
        major: 21,
        home: "/usr/lib/jvm/jdk-21",
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
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
            cancelStarted?.();
          });
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
        const dossier = functionDossierSchema.parse(ghidraFunctionDossier());
        dossier.procedure.name = name;
        dossier.pseudocode = `void ${name}() {}`;
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
        return ok(
          operation === "procedure_pseudo_code" ? dossier.pseudocode : dossier,
        );
      },
      close: async () => ok(null),
    }),
  );
  return {
    calls,
    cancellationReady,
    session: createTestBinarySession(provider),
  };
};

const open = async (session: ReturnType<typeof fixture>["session"]) => {
  const preview = await session.previewTarget(TARGET);
  if (!preview.ok) throw preview.error;
  expect((await session.openResolvedTarget(preview.value)).ok).toBe(true);
};

describe("Ghidra snapshot cache", () => {
  it.each([
    { operation: "analyze_function", parameters: { procedure: "0x1000" } },
    {
      operation: "procedure_pseudo_code",
      parameters: { procedure: "0x1000", document: "fixture" },
    },
  ] as const)(
    "replays repeated $operation calls and imported snapshots despite private project writes",
    async ({ operation, parameters }) => {
      const initial = fixture();
      await open(initial.session);
      const first = await initial.session.execute(operation, parameters);
      expect(first.ok).toBe(true);
      const second = await initial.session.execute(operation, parameters);
      expect(second).toMatchObject({
        ok: true,
        value: {
          limitations: expect.arrayContaining([
            expect.stringContaining("local REA analysis snapshot"),
          ]),
        },
      });
      expect(second.ok && second.value.result).toEqual(
        first.ok && first.value.result,
      );
      expect(initial.calls).toEqual([operation]);
      const snapshot = initial.session.exportAnalysisSnapshot();
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.entries).toHaveLength(1);
      expect(snapshot.value.binding.analysis_profile.provider.version).toBe(
        "12.1.4",
      );
      await initial.session.close();

      const replay = fixture();
      expect(replay.session.importAnalysisSnapshot(snapshot.value).ok).toBe(
        true,
      );
      await open(replay.session);
      const imported = await replay.session.execute(operation, parameters);
      expect(imported.ok && imported.value.result).toEqual(
        first.ok && first.value.result,
      );
      expect(replay.calls).toEqual([]);
      await replay.session.close();

      const changed = fixture("12.1.5");
      expect(changed.session.importAnalysisSnapshot(snapshot.value).ok).toBe(
        true,
      );
      expect(await changed.session.previewTarget(TARGET)).toMatchObject({
        ok: false,
        error: { _tag: "EvidenceIntegrityError" },
      });
      expect(changed.calls).toEqual([]);
    },
  );

  it("keeps annotation-dependent reads live after cancellation reimports the original artifact", async () => {
    const { session, calls, cancellationReady } = fixture();
    await open(session);
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
    for (let index = 0; index < 2; index += 1)
      expect(
        await session.execute("procedure_pseudo_code", parameters),
      ).toMatchObject({
        ok: true,
        value: { result: "void renamed() {}" },
      });
    expect(session.exportAnalysisSnapshot().ok).toBe(false);
    const controller = new AbortController();
    const cancelled = session.execute(
      "analyze_function",
      { procedure: "0x2000" },
      { signal: controller.signal },
    );
    await cancellationReady;
    controller.abort();
    expect(await cancelled).toMatchObject({
      ok: false,
      error: { _tag: "AnalysisCancelledError" },
    });
    for (let index = 0; index < 2; index += 1)
      expect(
        await session.execute("procedure_pseudo_code", parameters),
      ).toMatchObject({
        ok: true,
        value: { result: "void original() {}" },
      });
    expect(
      calls.filter((operation) => operation === "procedure_pseudo_code"),
    ).toHaveLength(5);
    expect(session.exportAnalysisSnapshot().ok).toBe(false);
    await session.close();
  });
});
