import type { RecordedCrash } from "../../../src/domain/native/recordedCrash.js";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import {
  createTestWorkspace,
  removeTestWorkspace,
} from "../../support/workspace/workspaceFixture.js";
import { PwntoolsRecordedCrashProvider } from "../../../src/native/pwntools/PwntoolsRecordedCrashProvider.js";
import { PWNTOOLS_PROVIDER_IDENTITY } from "../../../src/native/pwntools/PwntoolsRelease.js";
import { spawnOwnedProviderProcess } from "../../../src/process/ProviderProcess.js";
import { cleanupOwnedProcessGroup } from "../../../src/process/ProcessOwnership.js";
import { waitForProviderProcessReady } from "../../fixtures/providerProcess.js";
import {
  recordedCrashFixture,
  recordedCrashDebuggerFixture,
  recordedCrashFixtureBytes,
  recordedCrashSignalFixture,
} from "../../fixtures/binaryDiagnostics/recordedCrash.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { ProviderCleanupError } from "../../../src/domain/providerCleanupError.js";

const requestSchema = z.object({
  snapshot_path: z.string(),
  reply_path: z.string(),
});
const host = process.platform === "linux" && process.arch === "x64";

it
  .runIf(host)
  .each([
    "success",
    "wrong-register",
    "wrong-register-source",
    "missing-thread",
    "duplicate-thread",
    "missing-signal",
    "duplicate-signal",
    "missing-register",
    "duplicated-physical-thread",
    "duplicated-physical-signal",
    "omitted-physical-note",
    "hidden-segment",
    "wrong-header-range",
    "wrong-ei-version-zero",
    "wrong-ei-version-two",
    "wrong-e-version-zero",
    "wrong-e-version-two",
    "wrong-note-kind",
    "wrong-owner-display",
    "wrong-pid",
    "wrong-current-signal",
    "wrong-signal-number",
    "wrong-signal-code",
    "wrong-signal-errno",
    "wrong-signal-address",
    "wrong-raw-note",
    "malformed-range",
  ] as const)(
  "validates recorded source bytes and cleanup: %s",
  async (scenario) => {
    const { path, value, bytes } = await fixture(
      true,
      scenario === "wrong-owner-display",
    );
    if (scenario.startsWith("wrong-ei-version-"))
      bytes[6] = Number(scenario.at(-1));
    if (scenario.startsWith("wrong-e-version-"))
      bytes.writeUInt32LE(Number(scenario.at(-1)), 20);
    if (scenario.startsWith("wrong-e")) await writeFile(path, bytes);
    let owned = "";
    const provider = new PwntoolsRecordedCrashProvider(
      { REA_PWNTOOLS_PYTHON: process.execPath },
      async (spawn) => {
        owned = spawn.cwd ?? "";
        const request = requestSchema.parse(
          JSON.parse(await readFile(spawn.arguments.at(-1) ?? "", "utf8")),
        );
        expect(await readFile(request.snapshot_path)).toEqual(bytes);
        const payload = structuredClone(value);
        alterRecordedCrashReply(payload, scenario);
        const {
          artifact: _artifact,
          diagnostics: _diagnostics,
          debugger: _debugger,
          decoder_diagnostics: _decoderDiagnostics,
          ...raw
        } = payload;
        await writeFile(
          request.reply_path,
          JSON.stringify({
            ok: true,
            profile: PWNTOOLS_PROVIDER_IDENTITY.version,
            value: raw,
          }),
        );
        return spawnOwnedProviderProcess({
          ...spawn,
          command: process.execPath,
          arguments: ["-e", "process.stdout.write('recorded warning')"],
        });
      },
    );
    const result = await provider.inspect({
      path,
      include_debugger_context: false,
    });
    if (scenario === "success") {
      if (!result.ok) throw result.error;
      expect(result.value.threads).toEqual(value.threads);
      expect(result.value.diagnostics.stdout).toBe("recorded warning");
    } else
      expect(result).toMatchObject({
        ok: false,
        error: {
          _tag: "AnalysisOutputError",
          capturedOutput: { stdout: "recorded warning" },
        },
      });
    expect(await readFile(path)).toEqual(bytes);
    await expect(access(owned)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it
  .runIf(host)
  .each([
    "unconfigured",
    "success",
    "process-failure",
    "invalid-context",
    "cancelled",
    "cleanup-failure",
  ] as const)(
  "owns optional context from the same snapshot: %s",
  async (scenario) => {
    const { path, value, bytes, root } = await fixture();
    const controller = new AbortController();
    let owned = "";
    let snapshotPath = "";
    const venv = join(root, "venv");
    const plugin = join(root, "gdbinit.py");
    await mkdir(venv);
    await writeFile(plugin, "");
    const provider = new PwntoolsRecordedCrashProvider(
      {
        REA_PWNTOOLS_PYTHON: process.execPath,
        ...(scenario === "unconfigured"
          ? {}
          : {
              REA_PWNDBG_GDB: process.execPath,
              REA_PWNDBG_GDBINIT: plugin,
              REA_PWNDBG_VENV_PATH: venv,
            }),
      },
      async (spawn) => {
        const request = requestSchema.parse(
          JSON.parse(await readFile(spawn.arguments.at(-1) ?? "", "utf8")),
        );
        expect(await readFile(request.snapshot_path)).toEqual(bytes);
        if (snapshotPath === "") {
          snapshotPath = request.snapshot_path;
          owned = spawn.cwd ?? "";
          const {
            artifact: _artifact,
            diagnostics: _diagnostics,
            debugger: _debugger,
            decoder_diagnostics: _decoderDiagnostics,
            ...raw
          } = value;
          await writeFile(
            request.reply_path,
            JSON.stringify({
              ok: true,
              profile: PWNTOOLS_PROVIDER_IDENTITY.version,
              value: raw,
            }),
          );
          return spawnOwnedProviderProcess({
            ...spawn,
            command: process.execPath,
            arguments: ["-e", "process.stdout.write('basic stage diagnostic')"],
          });
        }
        expect(request.snapshot_path).toBe(snapshotPath);
        const context = recordedCrashDebuggerFixture();
        if (scenario === "invalid-context")
          context.maps = context.maps.map((map) => ({ ...map, end: "0x0" }));
        await writeFile(
          request.reply_path,
          JSON.stringify({ ok: true, value: context }),
        );
        const launched = await spawnOwnedProviderProcess({
          ...spawn,
          command: process.execPath,
          arguments: [
            "-e",
            scenario === "process-failure"
              ? "process.stderr.write('debugger failed',()=>{process.exitCode=9;})"
              : scenario === "cancelled"
                ? "process.stdout.write('ready\\n'); setInterval(() => {}, 1000)"
                : "process.stdout.write('debugger stage diagnostic')",
          ],
        });
        if (scenario === "cancelled") {
          await waitForProviderProcessReady(launched.process);
          setImmediate(() => controller.abort());
        }
        if (scenario === "cleanup-failure")
          return {
            ...launched,
            cleanup: async () => {
              await cleanupOwnedProcessGroup(launched.ownership);
              throw new Error("source-owned post-cleanup reporting failure");
            },
          };
        return launched;
      },
    );
    const result = await provider.inspect(
      {
        path,
        include_debugger_context: true,
      },
      { signal: controller.signal },
    );
    if (scenario === "success") {
      if (!result.ok) throw result.error;
      expect(result.value.debugger).toMatchObject({
        status: "available",
        maps: [{ permissions: null }],
        diagnostics: { stdout: "debugger stage diagnostic" },
      });
    } else {
      if (result.ok) throw new Error("Expected optional debugger failure");
      const projected = projectAnalysisError(result.error);
      if (scenario === "unconfigured")
        expect(projected).toMatchObject({
          details: { captured_output: { stdout: "basic stage diagnostic" } },
        });
      else if (
        scenario === "invalid-context" ||
        scenario === "cancelled" ||
        scenario === "cleanup-failure"
      ) {
        const serialized = JSON.stringify(projected);
        expect(serialized).toContain("basic stage diagnostic");
        expect(serialized).toContain(
          scenario === "cancelled" ? "ready" : "debugger stage diagnostic",
        );
        expect(result.error._tag).toBe(
          scenario === "invalid-context"
            ? "AnalysisOutputError"
            : scenario === "cancelled"
              ? "AnalysisCancelledError"
              : "ProviderAdapterError",
        );
        if (scenario === "cleanup-failure")
          expect(result.error).toBeInstanceOf(ProviderCleanupError);
      } else
        expect(projected).toMatchObject({
          category: "execution_failure",
          details: {
            diagnostics: {
              preceding_output: { stdout: "basic stage diagnostic" },
              stderr: "debugger failed",
            },
          },
        });
    }
    expect(await readFile(path)).toEqual(bytes);
    await expect(access(owned)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

const fixture = async (includeSignal = false, opaqueOwner = false) => {
  const workspace = await createTestWorkspace("rea-recorded-core-seam-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = join(workspace.root, "recorded.core");
  const value = includeSignal
    ? recordedCrashSignalFixture(path)
    : recordedCrashFixture(path);
  if (opaqueOwner) {
    value.notes = value.notes.map((note) =>
      note.index === 0
        ? {
            ...note,
            owner_bytes_base64: Buffer.from("EVIL\0").toString("base64"),
            owner_display: "EVIL",
          }
        : note,
    );
    value.threads = [];
  }
  const bytes = recordedCrashFixtureBytes(value);
  await writeFile(path, bytes);
  return { path, value, bytes, root: workspace.root };
};

const alterRecordedCrashReply = (
  payload: RecordedCrash,
  scenario: string,
): void => {
  if (scenario === "wrong-owner-display")
    payload.notes = payload.notes.map((note) =>
      note.index === 0 ? { ...note, owner_display: "FORGED" } : note,
    );
  if (
    scenario === "duplicated-physical-thread" ||
    scenario === "duplicated-physical-signal"
  ) {
    const noteIndex = scenario === "duplicated-physical-thread" ? 0 : 1;
    const note = payload.notes[noteIndex];
    if (note === undefined) throw new Error("missing fixture note");
    payload.notes.push({ ...note, index: 2 });
    if (noteIndex === 0)
      payload.threads.push(
        ...payload.threads.map((thread) => ({
          ...thread,
          note_index: 2,
        })),
      );
    else
      payload.signals.push(
        ...payload.signals.map((signal) => ({
          ...signal,
          note_index: 2,
        })),
      );
  }
  if (scenario === "omitted-physical-note") {
    payload.notes = payload.notes.filter((note) => note.index === 0);
    payload.signals = [];
  }
  if (scenario === "hidden-segment") {
    payload.segments = [];
    payload.notes = [];
    payload.threads = [];
    payload.signals = [];
  }
  if (scenario === "wrong-header-range")
    payload.segments = payload.segments.map((segment) => ({
      ...segment,
      header_location: { offset: "0x0", bytes: "0x38" },
    }));
  if (scenario === "wrong-note-kind") {
    payload.notes = payload.notes.map((note) =>
      note.index === 0 ? { ...note, type: "NT_AUXV" } : note,
    );
    payload.threads = [];
  }
  if (scenario === "wrong-register-source")
    payload.threads = payload.threads.map((thread) => ({
      ...thread,
      registers: thread.registers.map((register) =>
        register.name === "rdi"
          ? {
              ...register,
              value: "0x0",
              location: { offset: "0x104", bytes: "0x8" },
            }
          : register,
      ),
    }));
  if (scenario === "missing-thread") payload.threads = [];
  if (scenario === "duplicate-thread")
    payload.threads = [...payload.threads, ...payload.threads];
  if (scenario === "missing-signal") payload.signals = [];
  if (scenario === "duplicate-signal")
    payload.signals = [...payload.signals, ...payload.signals];
  if (scenario === "missing-register")
    payload.threads = payload.threads.map((thread) => ({
      ...thread,
      registers: thread.registers.slice(1),
    }));
  if (scenario === "wrong-register")
    payload.threads = payload.threads.map((t) => ({
      ...t,
      registers: t.registers.map((r) => ({ ...r, value: "0x1" })),
    }));
  if (scenario === "wrong-pid")
    payload.threads = payload.threads.map((thread) => ({
      ...thread,
      historical_pid: -2,
    }));
  if (scenario === "wrong-current-signal")
    payload.threads = payload.threads.map((thread) => ({
      ...thread,
      recorded_current_signal: -1,
    }));
  if (scenario.startsWith("wrong-signal"))
    payload.signals = payload.signals.map((signal) => ({
      ...signal,
      ...(scenario === "wrong-signal-number"
        ? {
            number: 10,
            fault_address: null,
            fault_address_meaning: "unknown" as const,
          }
        : scenario === "wrong-signal-code"
          ? { code: 2 }
          : scenario === "wrong-signal-errno"
            ? { errno: 0 }
            : { fault_address: "0x1" }),
    }));
  if (scenario === "wrong-raw-note")
    payload.notes = payload.notes.map((n) => ({
      ...n,
      descriptor_bytes_base64: Buffer.alloc(336, 1).toString("base64"),
    }));
  if (scenario === "malformed-range")
    payload.notes = payload.notes.map((n) => ({
      ...n,
      descriptor_location: { offset: "0x200", bytes: "0x150" },
    }));
};
