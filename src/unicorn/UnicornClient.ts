import { fileURLToPath } from "node:url";

import type {
  AnalysisClient,
  AnalysisExecution,
  AnalysisOperation,
  ExecutionOptions,
} from "../application/AnalysisProvider.js";
import { createAnalysisExecution } from "../application/AnalysisProvider.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisInputError,
} from "../domain/analysisErrorCore.js";
import type { JsonValue } from "../domain/jsonValue.js";
import { err, ok, type Result } from "../domain/result.js";
import {
  emulateFunctionInputSchema,
  type EmulateFunctionOutput,
} from "../contracts/unicorn/unicornToolContracts.js";
import {
  runUnicornBridge,
  UNICORN_OPERATION,
  type UnicornBridgeLauncher,
} from "./UnicornBridge.js";
import { validateEmulationHarness } from "./UnicornHarness.js";
import {
  UNICORN_BASELINE_LIMITATIONS,
  UNICORN_PROVIDER_IDENTITY,
} from "./UnicornProviderMetadata.js";
import { UNICORN_LIMITS, UNICORN_PYTHON_ENV_VAR } from "./UnicornRelease.js";

/**
 * Startup allowance added to the emulation budget for the outer bridge
 * deadline. The worker's own timer enforces budgets.timeout_ms from when it
 * starts; this covers Python/pwntools import, request handling, and the
 * reply round-trip so the parent does not expire first and discard the
 * worker's own timeout report. Timeout errors still name the budget.
 */
const BRIDGE_STARTUP_ALLOWANCE_MS = 30_000;

export interface UnicornClientOptions {
  readonly bridgePath?: string;
  readonly launcher?: UnicornBridgeLauncher;
  /** Test hook: parent directory for per-run directories. */
  readonly runtimeDirBase?: string;
}

/**
 * Target-agnostic Phase 1 client: the harness carries raw function bytes, so
 * the bound target (if any) is not consulted. Bound-target inventory
 * resolution is later work; the optional function_sha256 input binds a run
 * to caller-supplied bytes when the caller wants that check.
 */
export class UnicornClient implements AnalysisClient {
  readonly #environment: Readonly<NodeJS.ProcessEnv>;
  readonly #bridgePath: string;
  readonly #launcher: UnicornBridgeLauncher | undefined;
  readonly #runtimeDirBase: string | undefined;

  constructor(
    environment: Readonly<NodeJS.ProcessEnv>,
    options: UnicornClientOptions = {},
  ) {
    this.#environment = environment;
    this.#bridgePath =
      options.bridgePath ??
      fileURLToPath(
        new URL("../../bridge/unicorn/emulate_function.py", import.meta.url),
      );
    this.#launcher = options.launcher;
    this.#runtimeDirBase = options.runtimeDirBase;
  }

  async execute(
    operation: AnalysisOperation,
    parameters: Readonly<Record<string, JsonValue>>,
    options?: ExecutionOptions,
  ): Promise<Result<AnalysisExecution, AnalysisError>> {
    if (operation === "health")
      return ok(createAnalysisExecution(null, UNICORN_PROVIDER_IDENTITY));
    if (operation !== UNICORN_OPERATION)
      return err(
        new AnalysisCapabilityUnavailableError(
          UNICORN_PROVIDER_IDENTITY.id,
          operation,
          `Unicorn provider does not implement ${operation}.`,
        ),
      );
    const parsed = emulateFunctionInputSchema.safeParse(parameters);
    if (!parsed.success)
      return err(
        new AnalysisInputError(
          UNICORN_OPERATION,
          {},
          parsed.error.issues.map((issue) => ({
            path: issue.path.filter(
              (segment): segment is string | number =>
                typeof segment === "string" || typeof segment === "number",
            ),
            reason:
              issue.code === "invalid_type"
                ? "invalid_type"
                : issue.code === "too_small" || issue.code === "too_big"
                  ? "out_of_range"
                  : "invalid_value",
            message: issue.message,
          })),
        ),
      );
    const input = parsed.data;
    const harnessIssues = validateEmulationHarness(input);
    if (harnessIssues.length > 0)
      return err(new AnalysisInputError(UNICORN_OPERATION, {}, harnessIssues));

    const pythonPath = this.#environment[UNICORN_PYTHON_ENV_VAR] ?? "";
    const result = await runUnicornBridge({
      pythonPath,
      bridgePath: this.#bridgePath,
      request: {
        architecture: input.architecture,
        function_bytes: input.function_bytes,
        entry_offset: input.entry_offset,
        code_address: input.code_address,
        registers: input.registers,
        memory: input.memory,
        stack_address: input.stack_address,
        stack_size: input.stack_size,
        stubs: input.stubs,
        stub_policy: input.stub_policy,
        budgets: input.budgets,
      },
      timeoutMs: input.budgets.timeout_ms + BRIDGE_STARTUP_ALLOWANCE_MS,
      budgetMs: input.budgets.timeout_ms,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(this.#launcher === undefined ? {} : { launcher: this.#launcher }),
      ...(this.#runtimeDirBase === undefined
        ? {}
        : { runtimeDirBase: this.#runtimeDirBase }),
    });
    if (!result.ok) return err(result.error);
    const reply = result.value;
    if (reply.ok !== true || "probe" in reply)
      return err(
        new AnalysisCapabilityUnavailableError(
          UNICORN_PROVIDER_IDENTITY.id,
          UNICORN_OPERATION,
          "Unicorn bridge returned an unexpected reply shape.",
        ),
      );
    const output: EmulateFunctionOutput = {
      stop_reason: reply.stop_reason,
      return_value: reply.return_value,
      registers: reply.registers,
      memory_writes: reply.memory_writes,
      memory_diff_truncated: reply.memory_diff_truncated,
      calls_hit: reply.calls_hit,
      instructions_executed: reply.instructions_executed,
      engine: reply.engine,
    };
    const limitations = [...UNICORN_BASELINE_LIMITATIONS];
    if (reply.stop_reason !== "returned")
      limitations.push(
        `Run stopped early: ${reply.stop_reason}; effects after the stop are unobserved.`,
      );
    if (reply.memory_diff_truncated)
      limitations.push(
        `Memory-write diff was truncated at the ${String(UNICORN_LIMITS.maxMemoryDiffBytes)}-byte budget; later writes are unreported.`,
      );
    if (reply.calls_hit.length > 0)
      limitations.push(
        `${String(reply.calls_hit.length)} import/syscall call(s) were stubbed and recorded, never executed on the host.`,
      );
    return ok(
      createAnalysisExecution(output, UNICORN_PROVIDER_IDENTITY, {
        limitations,
        // Target-free run: caller-supplied bytes, not an opened artifact.
        // An explicit null subject keeps the session from substituting the
        // active target, and controlled-replay authority says the record
        // comes from replay, not from shipped-artifact provenance.
        subject: null,
        authority: "controlled-replay",
        environment: {
          id: "unicorn-2.1.2",
          platform: process.platform,
          architecture: input.architecture,
          isolation: "process",
        },
        subjectUnavailableReason:
          "Target-free Unicorn run: function bytes are caller-supplied, not an opened artifact.",
      }),
    );
  }

  async close(): Promise<Result<null, AnalysisError>> {
    // The client holds no persistent resources: every run owns and removes
    // its own directory, and the bridge subprocess is supervised per run.
    return ok(null);
  }
}
