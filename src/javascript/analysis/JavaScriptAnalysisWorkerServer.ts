import { writeWorkerControlFrame } from "../../process/writeWorkerControlFrame.js";
import {
  javaScriptMemberMutationAllowanceFromField,
  type JavaScriptMemberMutationAllowance,
} from "../../domain/javascript/javascriptSemanticWorkAllowance.js";
import type { JavaScriptSemanticPrecisionInput } from "../../domain/javascript/javascriptSemanticPrecision.js";
import { fitJavaScriptRouteSourceFacts } from "../../domain/javascript/javascriptRouteResultBudget.js";
import { jsonValueByteLength } from "../../domain/jsonValueByteLength.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import type {
  JavaScriptSemanticProjectionCapacity,
  JavaScriptSemanticFileProjection,
} from "../../domain/javascript/javascriptSemanticFileProjection.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getHeapStatistics } from "node:v8";
import {
  readBoundedControlLines,
  type BoundedControlLine,
} from "../../process/BoundedControlLines.js";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { isHostLimitFailure } from "../../domain/parseFailure.js";
import { javaScriptRuntime } from "../../domain/runtimeVersion.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import type { JavaScriptPackageType } from "../../domain/javascript/javascriptSourceParser.js";
import type { JavaScriptStaticAnalysis } from "../../domain/javascript/javascriptStaticAnalysisTypes.js";
import type { JavaScriptModuleSemanticIr } from "../../domain/javascript/javascriptModuleSemanticIr.js";
import {
  javaScriptTransferByteBudget,
  writeJavaScriptAnalysisTransfer,
} from "./JavaScriptAnalysisTransfer.js";
import { javaScriptWorkerStaticAnalysisSchema } from "./JavaScriptAnalysisWorkerSchemas.js";
import {
  JAVASCRIPT_ANALYSIS_WORKER_DEFAULTS as DEFAULTS,
  javaScriptCheckpointCeilingRemediation,
  javaScriptWorkerRequestSchema,
  javaScriptWorkerAdmissionSchema,
  javaScriptWorkerMessageSchema,
  type JavaScriptWorkerMessage,
} from "./JavaScriptAnalysisWorkerProtocol.js";
import { errorMessage } from "../../kernel/errorMessage.js";
import { sha256Hex } from "../../kernel/sha256Hex.js";

/** Trusted composition callback; this provider owns framing and temporary I/O. */
export interface JavaScriptSourceWorkerAnalyzer {
  (
    file: JavaScriptArtifactFile,
    capacity: JavaScriptSemanticProjectionCapacity,
    callbacks: {
      readonly phase: (
        phase: "parse" | "static" | "semantic" | "projection",
      ) => Promise<void>;
      readonly checkpoint: (facts: JavaScriptStaticAnalysis) => Promise<number>;
      /**
       * Preload discovery computed these complete facts; keep their checkpoint
       * so the normal pass of the same source can skip static analysis.
       */
      readonly retainStatic: (facts: JavaScriptStaticAnalysis) => void;
      /** Static facts that preload discovery retained for this exact request. */
      readonly reusedStatic: () => ReusedJavaScriptStatic | undefined;
      /** Checkpoint retained facts exactly as the static phase would have. */
      readonly checkpointReused: (
        reused: ReusedJavaScriptStatic,
      ) => Promise<number>;
    },
    packageType: JavaScriptPackageType,
    purpose: "analysis" | "preload-discovery" | "structure-only",
    precision: JavaScriptSemanticPrecisionInput | undefined,
    memberMutationAllowance: JavaScriptMemberMutationAllowance,
  ): Promise<{
    readonly module: JavaScriptModuleSemanticIr;
    readonly projection: JavaScriptSemanticFileProjection;
  } | null>;
}

/** The facts the normal pass reads after a reused static checkpoint. */
export interface ReusedJavaScriptStatic {
  readonly parse_status: JavaScriptStaticAnalysis["parse_status"];
  readonly call_paths: JavaScriptStaticAnalysis["electron"]["call_paths"];
}

export interface RetainedStaticCheckpoint extends ReusedJavaScriptStatic {
  readonly text: string;
  readonly retainedBytes: number;
}

/**
 * Static checkpoints from preload discovery, consumed by the normal pass of
 * the same worker. Static analysis is deterministic for the request fields in
 * the key, so a reused checkpoint is byte-identical to a recomputed one. The
 * store keeps at most one eighth of the V8 heap limit and stays empty where
 * the runtime does not report one; a miss recomputes.
 */
const retainedStatics = new Map<string, RetainedStaticCheckpoint>();
let retainedStaticBytes = 0;

export const javaScriptStaticReuseKey = (
  request: ReturnType<typeof javaScriptWorkerRequestSchema.parse>,
): string =>
  JSON.stringify([
    request.file.container_sha256,
    request.file.path,
    request.text_sha256,
    request.package_type,
    request.semantic_precision ?? null,
    request.member_mutation_allowance,
  ]);

const staticReuseCapacityBytes = (): number =>
  javaScriptRuntime(process.versions).id === "node"
    ? Math.floor(getHeapStatistics().heap_size_limit / 8)
    : 0;

export const retainJavaScriptStaticCheckpoint = (
  key: string,
  facts: JavaScriptStaticAnalysis,
): void => {
  const previous = retainedStatics.get(key);
  if (previous !== undefined) {
    retainedStatics.delete(key);
    retainedStaticBytes -= previous.retainedBytes;
  }
  // Skip encoding where reuse is disabled or no capacity remains.
  const capacity = staticReuseCapacityBytes();
  if (retainedStaticBytes >= capacity) return;
  let text: string;
  let retainedBytes: number;
  try {
    text = encodeJavaScriptStaticCheckpoint(facts);
    // UTF-16 strings and the retained call-path objects, conservatively.
    retainedBytes =
      2 * text.length +
      2 * (JSON.stringify(facts.electron.call_paths) ?? "").length;
  } catch {
    // Reuse is only an optimization: the normal pass recomputes and reports
    // the same refusal, so retention never fails preload discovery.
    return;
  }
  if (retainedStaticBytes + retainedBytes > capacity) return;
  retainedStatics.set(key, {
    text,
    retainedBytes,
    parse_status: facts.parse_status,
    call_paths: facts.electron.call_paths,
  });
  retainedStaticBytes += retainedBytes;
};

export const takeJavaScriptStaticCheckpoint = (
  key: string,
): RetainedStaticCheckpoint | undefined => {
  const retained = retainedStatics.get(key);
  if (retained === undefined) return undefined;
  retainedStatics.delete(key);
  retainedStaticBytes -= retained.retainedBytes;
  return retained;
};

/** Validate, fit and bound static facts as the checkpoint the parent reads. */
export const encodeJavaScriptStaticCheckpoint = (
  facts: JavaScriptStaticAnalysis,
): string => {
  let value = javaScriptWorkerStaticAnalysisSchema.parse(facts);
  if (value.routes !== undefined) {
    const { routes, ...existing } = value;
    // This is schema-checked, producer-owned JSON. Interface optional
    // members can only make the size estimate conservative.
    const available =
      DEFAULTS.checkpointBytes -
      jsonValueByteLength(existing as JsonValue, DEFAULTS.checkpointBytes) -
      Buffer.byteLength(',"routes":');
    const admitted = fitJavaScriptRouteSourceFacts(routes, available);
    value =
      admitted === undefined ? existing : { ...existing, routes: admitted };
  }
  const text = JSON.stringify(value);
  const bytes = Buffer.byteLength(text);
  if (bytes > DEFAULTS.checkpointBytes)
    throw new AnalysisResourceConstraintError(
      "analyze_javascript_application",
      "transport",
      `JavaScript static checkpoint exceeds its ${String(DEFAULTS.checkpointBytes)}-byte complete-fact ceiling. This release has no runtime override.`,
      {
        checkpoint_bytes: bytes,
        checkpoint_limit_bytes: DEFAULTS.checkpointBytes,
      },
      {
        remediationAction: javaScriptCheckpointCeilingRemediation(
          DEFAULTS.checkpointBytes,
        ),
      },
    );
  return text;
};

const send = async (input: JavaScriptWorkerMessage): Promise<void> => {
  await writeWorkerControlFrame(
    javaScriptWorkerMessageSchema.parse(input),
    DEFAULTS.protocolBytes,
    "JavaScript worker control frame exceeds its byte budget",
  );
};

/** Serve sequential inert-source requests from a parent-owned private runtime root. */
export const serveJavaScriptAnalysisWorker = async (
  analyze: JavaScriptSourceWorkerAnalyzer,
): Promise<void> => {
  const root = process.cwd();
  const requests = readBoundedControlLines(
    process.stdin.iterator({ destroyOnReturn: false }),
    DEFAULTS.protocolBytes,
  );
  await send({
    kind: "ready",
    heap_limit_bytes:
      javaScriptRuntime(process.versions).id === "node"
        ? getHeapStatistics().heap_size_limit
        : null,
  });
  try {
    for (;;) {
      const next = await requests.next();
      if (next.done) break;
      if (!next.value.ok) {
        if (next.value.error._tag === "ControlLineMalformedUtf8")
          throw new TypeError("JavaScript worker request is not valid UTF-8");
        throw new RangeError(
          "JavaScript worker request exceeds its byte budget",
        );
      }
      const raw: unknown = JSON.parse(next.value.value);
      const request = javaScriptWorkerRequestSchema.parse(raw);
      // Function scope releases source AST/IR/results before accepting another job.
      await analyzeJob(root, request, analyze, requests);
      if (
        process.memoryUsage().heapUsed >
        getHeapStatistics().heap_size_limit / 2
      )
        global.gc?.();
    }
  } finally {
    await requests.return(undefined);
  }
};

const analyzeJob = async (
  root: string,
  request: ReturnType<typeof javaScriptWorkerRequestSchema.parse>,
  analyze: JavaScriptSourceWorkerAnalyzer,
  requests: AsyncIterator<BoundedControlLine>,
): Promise<void> => {
  try {
    let resultBudgetBytes = 0;
    const source = await readFile(join(root, `${request.id}.source`), "utf8");
    if (sha256Hex(source) !== request.text_sha256)
      throw new TypeError(
        "JavaScript worker source text digest does not match its request",
      );
    const reuseKey = javaScriptStaticReuseKey(request);
    // Write one checkpoint and wait for the parent's semantic admission.
    const writeStaticCheckpoint = async (text: string): Promise<number> => {
      const bytes = Buffer.byteLength(text);
      await writeFile(join(root, `${request.id}.static.json`), text, {
        flag: "wx",
        mode: 0o600,
      });
      await send({
        kind: "static",
        id: request.id,
        bytes,
        sha256: sha256Hex(text),
      });
      const next = await requests.next();
      if (
        !next.done &&
        !next.value.ok &&
        next.value.error._tag === "ControlLineMalformedUtf8"
      )
        throw new TypeError(
          "JavaScript worker admission frame is not valid UTF-8",
        );
      if (next.done || !next.value.ok)
        throw new TypeError(
          "JavaScript worker admission frame is missing or oversized",
        );
      const raw: unknown = JSON.parse(next.value.value);
      const admission = javaScriptWorkerAdmissionSchema.parse(raw);
      if (admission.id !== request.id)
        throw new TypeError(
          "JavaScript worker admission names a different source job",
        );
      return admission.semantic_result_budget_bytes;
    };
    const result = await analyze(
      {
        ...request.file,
        text: { included: true, value: source },
      },
      { nodes: request.node_budget, unknowns: request.unknown_budget },
      {
        phase: async (phase) => send({ kind: "phase", id: request.id, phase }),
        checkpoint: async (facts) =>
          (resultBudgetBytes = await writeStaticCheckpoint(
            encodeJavaScriptStaticCheckpoint(facts),
          )),
        retainStatic: (facts) => {
          retainJavaScriptStaticCheckpoint(reuseKey, facts);
        },
        reusedStatic: () => takeJavaScriptStaticCheckpoint(reuseKey),
        checkpointReused: async (reused) =>
          (resultBudgetBytes = await writeStaticCheckpoint(
            (reused as RetainedStaticCheckpoint).text,
          )),
      },
      request.package_type,
      request.purpose,
      request.semantic_precision,
      javaScriptMemberMutationAllowanceFromField(
        request.member_mutation_allowance,
      ),
    );
    await send({ kind: "phase", id: request.id, phase: "transfer" });
    const descriptor =
      result === null
        ? null
        : await writeJavaScriptAnalysisTransfer(
            join(root, `${request.id}.records`),
            result.module,
            result.projection,
            javaScriptTransferByteBudget(resultBudgetBytes),
          );
    await send({ kind: "complete", id: request.id, descriptor });
  } catch (cause: unknown) {
    const hostLimit = isHostLimitFailure(cause);
    await send({
      kind: "failure",
      id: request.id,
      reason:
        cause instanceof AnalysisResourceConstraintError || hostLimit
          ? "resource"
          : cause instanceof TypeError
            ? "output"
            : "io",
      resource:
        cause instanceof AnalysisResourceConstraintError
          ? cause.resource
          : hostLimit
            ? "memory"
            : null,
      limits:
        cause instanceof AnalysisResourceConstraintError
          ? cause.reportedLimits
          : null,
      // The parent owns resource-error formatting; send its canonical reason.
      message:
        cause instanceof AnalysisResourceConstraintError
          ? cause.reason
          : errorMessage(cause),
    });
  }
};
