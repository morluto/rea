import {
  runJob,
  type ApprovalGate,
  type RunJobResult,
} from "@rea-studio/agent";
import type { JobRecord, ModelConfig, StudioStore } from "@rea-studio/core";
import type { LanguageModel } from "ai";

const POLL_MS = 1_000;

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Approvals are rows the web UI decides on. The job waits, in the
 * waiting_approval state, until a decision or a cancellation arrives.
 */
export const databaseGate = (
  store: StudioStore,
  jobId: string,
  signal: AbortSignal,
): ApprovalGate => ({
  async request(request) {
    const approval = store.createApproval(jobId, request);
    store.appendEvent(jobId, {
      type: "approval",
      approvalId: approval.id,
      kind: request.kind,
      status: "requested",
      title: request.title,
      detail: request.detail,
    });
    store.setJobStatus(jobId, "waiting_approval");
    try {
      for (;;) {
        if (signal.aborted) {
          store.decideApproval(approval.id, false, "Job cancelled.");
          return { approved: false, note: "Job cancelled." };
        }
        const current = store.getApproval(approval.id);
        if (current && current.status !== "pending") {
          store.appendEvent(jobId, {
            type: "approval",
            approvalId: approval.id,
            kind: request.kind,
            status: current.status,
            title: request.title,
            detail: "",
            ...(current.note ? { note: current.note } : {}),
          });
          return {
            approved: current.status === "approved",
            ...(current.note ? { note: current.note } : {}),
          };
        }
        await sleep(POLL_MS);
      }
    } finally {
      if (!signal.aborted) store.setJobStatus(jobId, "running");
    }
  },
});

export interface ProcessJobOptions {
  readonly createModel?: (config: ModelConfig) => LanguageModel;
  /** Aborted when the worker shuts down. */
  readonly shutdown?: AbortSignal;
}

/** Run one claimed job to completion and record its final state. */
export const processJob = async (
  store: StudioStore,
  job: JobRecord,
  options: ProcessJobOptions = {},
): Promise<RunJobResult> => {
  const controller = new AbortController();
  const signal = options.shutdown
    ? AbortSignal.any([controller.signal, options.shutdown])
    : controller.signal;
  const watcher = setInterval(() => {
    if (store.isCancelRequested(job.id)) {
      controller.abort(new Error("Cancelled by the user."));
    }
  }, POLL_MS);
  try {
    const analysis = store.getModelConfig(job.analysisModelId);
    const build = store.getModelConfig(job.buildModelId);
    if (!analysis || !build) {
      throw new Error("The selected model configuration no longer exists.");
    }
    const result = await runJob({
      spec: job.spec,
      secrets: store.getJobSecrets(job.id),
      models: {
        analysis: {
          ...analysis,
          ...(job.pricing?.analysis ? { pricing: job.pricing.analysis } : {}),
        },
        build: {
          ...build,
          ...(job.pricing?.build ? { pricing: job.pricing.build } : {}),
        },
      },
      workspaceRoot: job.workspace,
      emit: (event) => store.appendEvent(job.id, event),
      approvals: databaseGate(store, job.id, signal),
      signal,
      onUsage: (usage) => store.setJobUsage(job.id, usage),
      ...(options.createModel ? { createModel: options.createModel } : {}),
    });
    store.setJobUsage(job.id, result.usage);
    store.setJobStatus(job.id, result.status, result.error);
    return result;
  } catch (cause: unknown) {
    const message = cause instanceof Error ? cause.message : String(cause);
    store.appendEvent(job.id, {
      type: "done",
      status: "failed",
      error: message,
    });
    store.setJobStatus(job.id, "failed", message);
    return {
      status: "failed",
      error: message,
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
    };
  } finally {
    clearInterval(watcher);
  }
};
