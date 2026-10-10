import { randomUUID, createHash } from "node:crypto";
import { access, realpath, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import type {
  AnalysisExecution,
  ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { WasmArtifactPort } from "../application/wasm/WasmArtifactPort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import type {
  AnalysisError,
  AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisArtifactChangedError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { createEvidence } from "../domain/evidence.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import {
  wasmArtifactSchema,
  type InspectWasmArtifactInput,
} from "../domain/wasm/wasmArtifact.js";
import { err, ok, type Result } from "../domain/result.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import { WABT_PROVIDER_IDENTITY, WABT_LIMITS } from "./WabtRelease.js";
import { wabtFailure } from "./WabtFailures.js";
import { parseWabtHeaders } from "./WabtOutput.js";
import { parseWabtWat } from "./WabtWat.js";
import { associateWasmGlue } from "./WasmGlueAdapter.js";

type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];
const OPERATION = "inspect_wasm_artifact";
const digest = (text: string) =>
  createHash("sha256").update(text).digest("hex");
/** Run caller-supplied WABT against private copies of exactly selected bytes. */
export class WabtArtifactProvider implements WasmArtifactPort {
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-wabt-" }),
  ) {}
  async inspect(
    input: InspectWasmArtifactInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let phase: "configuration" | "artifact" | "producer" = "configuration";
    let result: Result<AnalysisExecution, AnalysisError>;
    let capturedOutput: AnalysisCapturedOutput | undefined;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      const directory = this.environment.REA_WABT_BIN_DIRECTORY ?? "";
      if (!isAbsolute(directory))
        throw new Error(
          "REA_WABT_BIN_DIRECTORY must be an absolute tool directory.",
        );
      const commands: {
        tool: string;
        path: string;
        sha256: string;
        version_banner: string;
        arguments: string[];
      }[] = [];
      for (const tool of ["wasm-validate", "wasm-objdump", "wasm2wat"]) {
        const path = await realpath(
          join(
            directory,
            `${tool}${process.platform === "win32" ? ".exe" : ""}`,
          ),
        );
        await access(path, constants.X_OK);
        const binary = await readStableArtifact(
          path,
          WABT_LIMITS.toolBytes,
          options?.signal,
        );
        commands.push({
          tool,
          path,
          sha256: binary.sha256,
          version_banner: "",
          arguments:
            tool === "wasm-objdump"
              ? ["-h", "-x", "module.wasm"]
              : ["--enable-all", "module.wasm"],
        });
      }
      root = await this.createRuntime();
      const snapshotPath = join(root.path, "module.wasm");
      let snapshotHash: string | undefined;
      const verifySnapshot = async () => {
        if (snapshotHash === undefined) return;
        try {
          const bytes = await readStableArtifact(
            snapshotPath,
            WABT_LIMITS.inputBytes,
            options?.signal,
          );
          if (bytes.sha256 !== snapshotHash)
            throw new Error("Private WASM snapshot bytes changed.");
        } catch (cause: unknown) {
          if (options?.signal?.aborted)
            throw new AnalysisCancelledError(OPERATION);
          throw new AnalysisArtifactChangedError(
            OPERATION,
            input.path,
            "Private WASM snapshot no longer matches selected byte identity.",
            { cause },
          );
        }
      };
      const execute = async (
        command: (typeof commands)[number],
        args: readonly string[],
        acceptNonZeroExit = false,
      ) => {
        await verifySnapshot();
        const snapshot = await runOwnedCommand(
          {
            command: command.path,
            arguments: args,
            ...(root === undefined ? {} : { cwd: root.path }),
            expectedCommand: command.path,
            runId: `rea-wabt-${randomUUID()}`,
            hostEnvironment: this.environment,
          },
          {
            timeoutMs: WABT_LIMITS.timeoutMs,
            diagnosticBytes: WABT_LIMITS.outputBytes,
            acceptNonZeroExit,
          },
          {
            ...(options?.signal === undefined
              ? {}
              : { signal: options.signal }),
            ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
          },
        );
        const current = await readStableArtifact(
          command.path,
          WABT_LIMITS.toolBytes,
          options?.signal,
        );
        if (current.sha256 !== command.sha256)
          throw new AnalysisOutputError(
            OPERATION,
            "Configured WABT executable changed during inspection.",
          );
        await verifySnapshot();
        return snapshot;
      };
      for (const command of commands) {
        const version = await execute(command, ["--version"]);
        if (
          version.stdout.text.trim() !== "1.0.42" ||
          version.stderr.text !== ""
        )
          throw new Error(
            `Unsupported ${command.tool} version banner; expected 1.0.42.`,
          );
        command.version_banner = version.stdout.text;
      }
      phase = "artifact";
      const selected = await readStableArtifact(
        input.path,
        WABT_LIMITS.inputBytes,
        options?.signal,
      );
      const artifact = {
        path: input.path,
        sha256: selected.sha256,
        bytes: selected.bytes.length,
      };
      const candidates = [];
      for (const path of new Set([input.path, ...input.candidate_paths])) {
        const bytes =
          path === input.path
            ? selected
            : await readStableArtifact(
                path,
                WABT_LIMITS.inputBytes,
                options?.signal,
              );
        candidates.push({
          path,
          sha256: bytes.sha256,
          bytes: bytes.bytes.length,
        });
      }
      const glue = [];
      for (const path of input.glue_paths) {
        const bytes = await readStableArtifact(
          path,
          WABT_LIMITS.inputBytes,
          options?.signal,
        );
        const source = new TextDecoder("utf-8", { fatal: true }).decode(
          bytes.bytes,
        );
        glue.push({
          artifact: { path, sha256: bytes.sha256, bytes: bytes.bytes.length },
          ...associateWasmGlue(
            source,
            path,
            candidates.map((candidate) => candidate.path),
          ),
        });
      }
      await writeFile(snapshotPath, selected.bytes, {
        flag: "wx",
        mode: 0o400,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      snapshotHash = selected.sha256;
      phase = "producer";
      const [validate, objdump, decode] = commands;
      if (
        validate === undefined ||
        objdump === undefined ||
        decode === undefined
      )
        throw new Error("Incomplete WABT tool profile.");
      const validation = await execute(validate, validate.arguments, true);
      if (validation.exitCode !== 0)
        throw new AnalysisInputError(
          OPERATION,
          {
            partialObservation: createEvidence(
              { path: input.path, format: "file", sha256: selected.sha256 },
              WABT_PROVIDER_IDENTITY,
              {
                operation: OPERATION,
                parameters: input,
                result: {
                  artifact,
                  validation: "rejected-by-selected-profile",
                  tool_profile: {
                    source: "https://github.com/WebAssembly/wabt",
                    release: "1.0.42",
                    source_commit: "ff0ef7e0009402740c805a9744c09b05be063e48",
                    commands,
                  },
                  exit_code: validation.exitCode ?? null,
                  stdout: validation.stdout.text,
                  stderr: validation.stderr.text,
                },
                confidence: "observed",
                locations: [{ kind: "artifact-path", path: input.path }],
                limitations: [
                  "WABT rejected these exact selected bytes with --enable-all; no complete inspection or target execution occurred.",
                ],
              },
            ),
            capturedOutput: {
              stdout: validation.stdout.text,
              stderr: validation.stderr.text,
              truncated: false,
            },
          },
          [
            {
              path: ["path"],
              reason: "invalid_format",
              message:
                "Selected bytes failed WABT validation with --enable-all; inspect retained upstream diagnostics.",
            },
          ],
        );
      const dump = await execute(objdump, objdump.arguments);
      capturedOutput = {
        stdout: dump.stdout.text,
        stderr: dump.stderr.text,
        truncated: false,
      };
      const separator = dump.stdout.text.indexOf("Section Details:\n");
      if (separator < 0)
        throw new AnalysisOutputError(
          OPERATION,
          "WABT section details are missing.",
        );
      const headers = dump.stdout.text.slice(0, separator);
      const details = `module.wasm:\tfile format wasm 0x1\n\n${dump.stdout.text.slice(separator)}`;
      const wat = await execute(decode, decode.arguments);
      if (
        !wat.stdout.text.startsWith("(module") ||
        wat.stderr.text !== "" ||
        dump.stderr.text !== ""
      )
        throw new AnalysisOutputError(
          OPERATION,
          "Unexpected WABT decoding output.",
        );
      const limitations = [
        "WAT is a decoded representation, not original source or proof of runtime behavior. Custom annotations may retain payloads, but WAT does not establish original binary layout or round-trip byte identity. Original bytes and objdump output remain authoritative.",
        "Imports and exports retain exact top-level WABT WAT forms. Names remain escaped producer text; unescaped objdump display names are not parsed as unambiguous identifiers.",
        "JavaScript references are AST-observed static literals only. Candidate matches are associations, not proven data flow, URL-to-file identity or runtime loading. Computed references and aliases are not resolved.",
        "No target execution or implicit fetch. WABT tools are trusted caller-supplied executables; SHA-256 identifies their bytes, not publisher authenticity. No OS memory sandbox is claimed.",
        "Each subprocess has a 30-second deadline and 32 MiB combined output budget. Oversized output fails instead of producing truncated success.",
      ];
      const report = wasmArtifactSchema.parse({
        artifact,
        validation: "valid",
        sections: parseWabtHeaders(headers, artifact.bytes),
        ...parseWabtWat(wat.stdout.text),
        headers,
        details,
        wat: {
          text: wat.stdout.text,
          sha256: digest(wat.stdout.text),
          representation: "decoded-wat",
        },
        tool_profile: {
          source: "https://github.com/WebAssembly/wabt",
          release: "1.0.42",
          source_commit: "ff0ef7e0009402740c805a9744c09b05be063e48",
          commands,
          timeout_ms: WABT_LIMITS.timeoutMs,
          output_budget_bytes: WABT_LIMITS.outputBytes,
        },
        candidates,
        glue,
        runtime_execution: "not-performed",
        network_fetch: "not-performed",
        limitations,
      });
      result = ok(
        createAnalysisExecution(report, WABT_PROVIDER_IDENTITY, {
          subject: {
            path: input.path,
            format: "file",
            sha256: selected.sha256,
          },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations,
        }),
      );
    } catch (cause: unknown) {
      const failure = wabtFailure(cause, phase, input.path);
      result = err(
        failure instanceof AnalysisOutputError &&
          failure.capturedOutput === undefined &&
          capturedOutput !== undefined
          ? new AnalysisOutputError(OPERATION, failure.reason, {
              cause,
              capturedOutput,
            })
          : failure,
      );
    }
    if (root !== undefined) {
      try {
        await root.close();
      } catch (cause: unknown) {
        result = err(
          new ProviderCleanupError(
            WABT_PROVIDER_IDENTITY.id,
            [root.path],
            {
              reason: cause instanceof Error ? cause.message : String(cause),
              previous_error: result.ok
                ? null
                : projectAnalysisError(result.error),
            },
            { operation: OPERATION, cause },
          ),
        );
      }
    }
    return result;
  }
}
