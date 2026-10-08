import { createHash, randomUUID } from "node:crypto";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  createAnalysisExecution,
  type AnalysisExecution,
  type ExecutionOptions,
} from "../application/AnalysisProvider.js";
import type { EvmInterfacePort } from "../application/evm/EvmInterfacePort.js";
import { readStableArtifact } from "../artifacts/readStableArtifact.js";
import { OwnedCommandFailure } from "../process/OwnedCommand.js";
import type {
  AnalysisError,
  AnalysisCapturedOutput,
} from "../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import { projectAnalysisError } from "../domain/analysisErrorProjection.js";
import type { InspectEvmInterfaceInput } from "../domain/evm/evmInterface.js";
import { evmInterfaceSchema } from "../domain/evm/evmInterface.js";
import { ProviderAdapterError } from "../domain/providerAdapterError.js";
import { ProviderCleanupError } from "../domain/providerCleanupError.js";
import { err, ok, type Result } from "../domain/result.js";
import { runOwnedCommand } from "../process/OwnedCommand.js";
import { PrivateRuntimeRoot } from "../process/PrivateRuntimeRoot.js";
import {
  evmInterfaceFailure,
  capturedEvmOutput,
  type EvmFileSizeFailureEvidence,
} from "./EvmoleFailures.js";
import {
  evmoleInterfaceReplySchema,
  projectEvmoleInterface,
} from "./EvmoleInterfaceAdapter.js";
import {
  EVMOLE_PROVIDER_IDENTITY,
  EVM_INTERFACE_LIMITS,
  EVM_FILE_SIZE_FAILURE_EXIT,
} from "./EvmoleRelease.js";
import { decodeEvmBytecodeCarrier } from "./EvmBytecodeCarrier.js";
import {
  selectEvmWorkerLimits,
  type EvmWorkerLimits,
} from "./EvmWorkerLimits.js";

const OPERATION = "inspect_evm_interface";
const replySchema = z.discriminatedUnion("ok", [
  z.strictObject({
    ok: z.literal(true),
    version: z.literal("0.9.3"),
    bytecode: z.strictObject({
      sha256: z.string().regex(/^[a-f0-9]{64}$/),
      bytes: z.number().int().nonnegative(),
      hex: z.string().regex(/^(?:[a-f0-9]{2})*$/),
    }),
    raw: evmoleInterfaceReplySchema,
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: z.enum(["format", "decoder", "output-limit", "unsupported"]),
    message: z.string(),
  }),
]);
type Launcher = NonNullable<Parameters<typeof runOwnedCommand>[2]>["launcher"];

/** Run unchanged EVMole/WASM in an owned worker; no target, chain or network execution. */
export class EvmoleInterfaceProvider implements EvmInterfacePort {
  constructor(
    readonly environment: Readonly<NodeJS.ProcessEnv> = process.env,
    readonly launcher?: Launcher,
    readonly createRuntime: () => Promise<
      Pick<PrivateRuntimeRoot, "path" | "close">
    > = () => PrivateRuntimeRoot.create({ prefix: "rea-evm-interface-" }),
  ) {}

  /** Bind recovered interface candidates to both original carrier and decoded byte identity. */
  async inspect(
    input: InspectEvmInterfaceInput,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    let root: Pick<PrivateRuntimeRoot, "path" | "close"> | undefined;
    let retainedOutput: AnalysisCapturedOutput | undefined;
    let phase: "configuration" | "artifact-read" | "worker" = "configuration";
    let workerLimits: EvmWorkerLimits | undefined;
    const limiter =
      this.environment.REA_EVM_PRLIMIT_COMMAND ?? "/usr/bin/prlimit";
    let result: Result<AnalysisExecution, AnalysisError>;
    try {
      if (options?.signal?.aborted) throw new AnalysisCancelledError(OPERATION);
      if (process.platform !== "linux" || process.arch !== "x64")
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          "Initial real-verified offline EVM interface profile supports Linux x64 only.",
        );
      try {
        if (!isAbsolute(limiter))
          throw new Error(
            "REA_EVM_PRLIMIT_COMMAND must be an absolute executable path.",
          );
        await access(limiter, constants.X_OK);
        if (!(await stat(limiter)).isFile())
          throw new Error(
            "Configured prlimit must be a regular executable file, not a directory.",
          );
      } catch (cause: unknown) {
        const reason = `Offline EVM interface inspection requires caller-supplied util-linux prlimit: ${limiter}; ${cause instanceof Error ? cause.message : String(cause)}`;
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          reason,
          { cause, userMessage: reason },
        );
      }
      let inheritedLimits: string;
      try {
        inheritedLimits = await readFile("/proc/self/limits", "utf8");
      } catch (cause: unknown) {
        const reason = `Could not read inherited Linux resource limits at /proc/self/limits: ${cause instanceof Error ? cause.message : String(cause)}`;
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          reason,
          { cause, userMessage: reason },
        );
      }
      const limits = selectEvmWorkerLimits(inheritedLimits);
      if (!limits.ok)
        throw new AnalysisCapabilityUnavailableError(
          EVMOLE_PROVIDER_IDENTITY.id,
          OPERATION,
          limits.error,
          { userMessage: limits.error },
        );
      workerLimits = limits.value;
      phase = "artifact-read";
      const carrier = await readStableArtifact(
        input.path,
        EVM_INTERFACE_LIMITS.inputBytes,
        options?.signal,
      );
      phase = "worker";
      root = await this.createRuntime();
      const snapshotPath = join(root.path, "carrier.snapshot");
      const requestPath = join(root.path, "request.json");
      const replyPath = join(root.path, "reply.json");
      await writeFile(snapshotPath, carrier.bytes, {
        flag: "wx",
        mode: 0o600,
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      await writeFile(
        requestPath,
        JSON.stringify({
          snapshot_path: snapshotPath,
          reply_path: replyPath,
          failure_marker_path: join(root.path, "resource.failure"),
          encoding: input.encoding,
        }),
        { flag: "wx", mode: 0o600 },
      );
      const { NODE_OPTIONS: _ambientNodeOptions, ...environment } =
        this.environment;
      const execution = await runOwnedCommand(
        {
          command: limiter,
          arguments: [
            `--as=${String(workerLimits.addressSpaceBytes)}:`,
            `--fsize=${String(workerLimits.fileSizeBytes)}:`,
            "--core=0:",
            `--cpu=${String(workerLimits.cpuSeconds)}:`,
            "--",
            process.execPath,
            "--max-old-space-size=256",
            "--v8-pool-size=1",
            "--disable-wasm-trap-handler",
            fileURLToPath(
              new URL("./EvmoleInterfaceWorker.js", import.meta.url),
            ),
            requestPath,
          ],
          cwd: root.path,
          expectedCommand: null,
          runId: `rea-evm-interface-${randomUUID()}`,
          hostEnvironment: environment,
        },
        {
          timeoutMs: EVM_INTERFACE_LIMITS.timeoutMs,
          diagnosticBytes: EVM_INTERFACE_LIMITS.diagnosticBytes,
        },
        {
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(this.launcher === undefined ? {} : { launcher: this.launcher }),
        },
      );
      const capturedOutput = capturedEvmOutput(execution);
      retainedOutput = capturedOutput;
      let reply: z.output<typeof replySchema>;
      try {
        const file = await readStableArtifact(
          replyPath,
          EVM_INTERFACE_LIMITS.outputBytes,
          options?.signal,
        );
        reply = replySchema.parse(JSON.parse(file.bytes.toString("utf8")));
      } catch (cause: unknown) {
        if (options?.signal?.aborted)
          throw new AnalysisCancelledError(OPERATION, { capturedOutput });
        throw new AnalysisOutputError(
          OPERATION,
          `Owned interface worker reply failed for ${input.path}: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause, capturedOutput },
        );
      }
      if (!reply.ok) {
        if (reply.reason === "unsupported")
          throw new AnalysisCapabilityUnavailableError(
            EVMOLE_PROVIDER_IDENTITY.id,
            OPERATION,
            reply.message,
            { userMessage: reply.message, capturedOutput },
          );
        if (reply.reason === "format")
          throw new AnalysisInputError(OPERATION, { capturedOutput }, [
            {
              path: ["path"],
              reason: "invalid_format",
              message: reply.message,
            },
          ]);
        if (reply.reason === "output-limit")
          throw new AnalysisOutputError(OPERATION, reply.message, {
            capturedOutput,
          });
        throw new ProviderAdapterError(EVMOLE_PROVIDER_IDENTITY.id, OPERATION, {
          diagnostics: {
            phase,
            failure_kind: reply.reason,
            reason: reply.message,
            stdout: execution.stdout.text,
            stderr: execution.stderr.text,
            captured_output: { ...capturedOutput },
          },
        });
      }
      const selectedBytes = decodeEvmBytecodeCarrier(
        carrier.bytes,
        input.encoding,
      );
      const selectedHex = Buffer.from(selectedBytes).toString("hex");
      const decodedHash = createHash("sha256")
        .update(selectedBytes)
        .digest("hex");
      if (
        decodedHash !== reply.bytecode.sha256 ||
        selectedHex !== reply.bytecode.hex ||
        selectedBytes.length !== reply.bytecode.bytes
      )
        throw new AnalysisOutputError(
          OPERATION,
          "Decoded bytecode representation does not match the selected carrier, encoding or reported SHA-256.",
          { capturedOutput },
        );
      const limitations = [
        `Configured worker resource soft limits: address_space_bytes=${String(workerLimits.addressSpaceBytes)}, cpu_seconds=${String(workerLimits.cpuSeconds)}, file_size_bytes=${String(workerLimits.fileSizeBytes)}. Selected from inherited tighter limits; original hard limits are retained. Effective worker limits are not independently probed.`,
        "Upstream may also report terminal metadata while recovering selectors. Its reported values are retained in raw_result, but integer precision and non-text-key coverage are unknown in the JS binding; complete original bytecode remains available.",
        "Recovered selectors, argument strings and mutability are upstream inferences, not verified ABI signatures or names. Empty results do not prove the absence of callable dispatch.",
        "Bytecode kind, hardfork and deployed-contract authenticity are unknown. This inspection performs no target runtime execution, chain/RPC lookup or network request.",
        "Original carrier and decoded bytecode SHA-256 are distinct identities; SHA-256 is not the Ethereum Keccak code hash.",
        "The owned worker has a 256 MiB JavaScript heap, 3 GiB virtual address-space limit and 30-second deadline. Virtual address space is distinct from resident memory; limits fail without partial success.",
      ];
      const validated = evmInterfaceSchema.safeParse({
        artifact: {
          path: input.path,
          sha256: carrier.sha256,
          bytes: carrier.bytes.length,
          encoding: input.encoding,
        },
        bytecode: {
          ...reply.bytecode,
          digest_algorithm: "sha256",
          kind: "unknown",
          deployment_authenticity: "unknown",
          hardfork: "unknown",
        },
        evidence_kind: "inferred",
        functions: projectEvmoleInterface(reply.raw).functions,
        discovery_completeness: "unknown",
        runtime_execution: "not-performed",
        diagnostics: {
          stdout: execution.stdout.text,
          stderr: execution.stderr.text,
          truncated: capturedOutput.truncated,
        },
        limitations,
      });
      if (!validated.success)
        throw new AnalysisOutputError(
          OPERATION,
          `Interface worker returned invalid bytecode-relative evidence: ${validated.error.issues[0]?.message ?? "schema mismatch"}`,
          { capturedOutput },
        );
      const report = validated.data;
      result = ok(
        createAnalysisExecution(report, EVMOLE_PROVIDER_IDENTITY, {
          rawResult: reply.raw,
          subject: { path: input.path, format: "file", sha256: carrier.sha256 },
          locations: [{ kind: "artifact-path", path: input.path }],
          limitations,
        }),
      );
    } catch (cause: unknown) {
      let fileFailure: EvmFileSizeFailureEvidence | undefined;
      if (
        cause instanceof OwnedCommandFailure &&
        cause.snapshot?.exitCode === EVM_FILE_SIZE_FAILURE_EXIT &&
        cause.snapshot.signal === null &&
        root !== undefined
      ) {
        try {
          const marker = await readStableArtifact(
            join(root.path, "resource.failure"),
            1,
          );
          if (!marker.bytes.equals(Buffer.from("F")))
            throw new Error(
              "Private worker failure marker does not match the observed exit status.",
            );
          fileFailure = { verified: true, failure: null };
        } catch (markerFailure: unknown) {
          fileFailure = {
            verified: false,
            failure:
              markerFailure instanceof Error
                ? markerFailure.message
                : String(markerFailure),
          };
        }
      }
      result = err(
        options?.signal?.aborted &&
          (cause === options.signal.reason ||
            (cause instanceof Error && cause.name === "AbortError"))
          ? new AnalysisCancelledError(
              OPERATION,
              retainedOutput === undefined
                ? undefined
                : { capturedOutput: retainedOutput },
            )
          : evmInterfaceFailure(
              cause,
              phase,
              input.path,
              workerLimits,
              limiter,
              fileFailure,
            ),
      );
    }
    if (root !== undefined) {
      try {
        await root.close();
      } catch (cause: unknown) {
        return err(
          new ProviderCleanupError(
            EVMOLE_PROVIDER_IDENTITY.id,
            [root.path],
            {
              reason: cause instanceof Error ? cause.message : String(cause),
              previous_error: result.ok
                ? null
                : projectAnalysisError(result.error),
              ...(retainedOutput === undefined
                ? {}
                : { captured_output: { ...retainedOutput } }),
            },
            { operation: OPERATION },
          ),
        );
      }
    }
    return result.ok && options?.signal?.aborted
      ? err(
          new AnalysisCancelledError(
            OPERATION,
            retainedOutput === undefined
              ? undefined
              : { capturedOutput: retainedOutput },
          ),
        )
      : result;
  }
}
