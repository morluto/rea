import type {
  ApprovalDecision,
  ApprovalRequest,
  JobEvent,
  JobSpec,
  PhaseId,
} from "@rea-studio/core";

import type { Redactor } from "./redact.js";

/** Decides on tool, command and specification approvals. */
export interface ApprovalGate {
  request(request: ApprovalRequest): Promise<ApprovalDecision>;
}

export type Emit = (event: JobEvent) => void;

/** State shared by every tool during one job run. */
export interface ToolContext {
  /** The phase currently running; tools tag their events with it. */
  phase: PhaseId;
  readonly emit: Emit;
  readonly redactor: Redactor;
  readonly approvals: ApprovalGate;
  readonly policy: JobSpec["approvals"];
  readonly signal: AbortSignal;
  nextSeq(): number;
}

/** Characters of a single tool result the model receives inline. */
export const MODEL_RESULT_CHARS = 16_000;
const PREVIEW_CHARS = 600;

export const clip = (text: string, max: number): string =>
  text.length <= max
    ? text
    : `${text.slice(0, max)}\n… [${text.length - max} more characters truncated]`;

export const preview = (text: string): string =>
  text.length <= PREVIEW_CHARS ? text : `${text.slice(0, PREVIEW_CHARS)}…`;

export const errorMessage = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

/** Ask for approval unless the job policy auto-approves this kind. */
export const approve = async (
  ctx: ToolContext,
  kind: "tool" | "command",
  title: string,
  detail: string,
): Promise<ApprovalDecision> => {
  const mode =
    kind === "tool" ? ctx.policy.destructiveTools : ctx.policy.commands;
  if (mode === "auto") return { approved: true };
  return ctx.approvals.request({
    kind,
    title: ctx.redactor.redact(title),
    detail: ctx.redactor.redact(detail),
  });
};
