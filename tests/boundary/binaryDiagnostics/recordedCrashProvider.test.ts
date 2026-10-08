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
    "wrong-raw-note",
    "malformed-range",
  ] as const)(
  "validates recorded source bytes and cleanup: %s",
  async (scenario) => {
    const { path, value, bytes } = await fixture();
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
        if (scenario === "wrong-register")
          payload.threads = payload.threads.map((t) => ({
            ...t,
            registers: t.registers.map((r) => ({ ...r, value: "0x1" })),
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

const fixture = async () => {
  const workspace = await createTestWorkspace("rea-recorded-core-seam-");
  onTestFinished(() => removeTestWorkspace(workspace.root));
  const path = join(workspace.root, "recorded.core");
  const value = recordedCrashFixture(path);
  const bytes = recordedCrashFixtureBytes(value);
  await writeFile(path, bytes);
  return { path, value, bytes, root: workspace.root };
};
