import type {
  AccessMode,
  HardeningId,
  PhaseId,
  ProviderId,
  ScopeMode,
  TargetKind,
} from "./catalog.js";
import type { ModelPricing } from "./pricing.js";

/** A model selection. `apiKey` is only present while decrypted in memory. */
export interface ModelConfig {
  readonly provider: ProviderId;
  readonly model: string;
  readonly apiKey?: string;
  readonly baseURL?: string;
  readonly pricing?: ModelPricing;
}

/** Non-secret cookie metadata the agent may see; values live in JobSecrets. */
export interface CookieDescriptor {
  readonly name: string;
  readonly domain: string;
  readonly path?: string;
}

export interface EnhancementSpec {
  /** Rewrite in another language, optionally with a framework. */
  readonly port?: { readonly language: string; readonly framework?: string };
  /** Free-text stack change, e.g. "React SPA to server-rendered HTMX". */
  readonly stack?: string;
  readonly hardening: readonly HardeningId[];
  readonly instructions?: string;
}

export interface JobSpec {
  readonly language?: "es" | "en";
  readonly title: string;
  readonly target: {
    readonly kind: TargetKind;
    /** Web start URL. */
    readonly url?: string;
    /** Absolute path of a local artifact (copied into the job input folder). */
    readonly path?: string;
  };
  readonly access: {
    readonly mode: AccessMode;
    readonly loginUrl?: string;
    /** Loopback Chrome DevTools port for "connect" mode. */
    readonly cdpPort?: number;
    readonly cookies?: readonly CookieDescriptor[];
  };
  readonly scope: { readonly mode: ScopeMode; readonly description: string };
  readonly enhancement: EnhancementSpec;
  readonly budget: {
    readonly maxStepsPerPhase: number;
    readonly maxTotalTokens?: number;
    readonly maxCostUsd?: number;
  };
  readonly approvals: {
    readonly destructiveTools: "ask" | "auto";
    readonly commands: "ask" | "auto";
    readonly specReview: boolean;
  };
  /** The requester confirmed they own the target or are authorized to analyze it. */
  readonly authorizationAttested: boolean;
}

/** Values that never reach the model, logs or the browser after saving. */
export interface JobSecrets {
  readonly username?: string;
  readonly password?: string;
  /** Cookie values keyed by the index of `JobSpec.access.cookies`. */
  readonly cookieValues?: readonly string[];
}

export type ApprovalKind = "tool" | "command" | "spec";

export interface ApprovalRequest {
  readonly kind: ApprovalKind;
  readonly title: string;
  readonly detail: string;
}

export interface ApprovalDecision {
  readonly approved: boolean;
  readonly note?: string;
}

export type ToolSource = "rea" | "workspace" | "studio";

export type JobEvent =
  | {
      readonly type: "phase";
      readonly phase: PhaseId;
      readonly status: "started" | "finished" | "skipped" | "failed";
      readonly summary?: string;
    }
  | { readonly type: "text"; readonly phase: PhaseId; readonly text: string }
  | {
      readonly type: "tool-call";
      readonly phase: PhaseId;
      readonly toolCallId: string;
      readonly tool: string;
      readonly source: ToolSource;
      readonly input: string;
    }
  | {
      readonly type: "tool-result";
      readonly phase: PhaseId;
      readonly toolCallId: string;
      readonly tool: string;
      readonly ok: boolean;
      readonly preview: string;
      readonly evidenceIds?: readonly string[];
      readonly savedTo?: string;
    }
  | {
      readonly type: "approval";
      readonly approvalId: string;
      readonly kind: ApprovalKind;
      readonly status: "requested" | "approved" | "rejected";
      readonly title: string;
      readonly detail: string;
      readonly note?: string;
    }
  | {
      readonly type: "usage";
      readonly phase: PhaseId;
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly totalTokens: number;
      readonly stepInputTokens?: number;
      readonly stepOutputTokens?: number;
      readonly estimatedCostUsd?: number;
      readonly unpricedTokens?: number;
      readonly model?: string;
      readonly provider?: ProviderId;
    }
  | {
      readonly type: "file";
      readonly path: string;
      readonly action: "write" | "edit";
    }
  | {
      readonly type: "log";
      readonly level: "info" | "warn" | "error";
      readonly message: string;
    }
  | {
      readonly type: "done";
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly reportPath?: string;
      readonly error?: string;
    };

export type JobStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "succeeded"
  | "failed"
  | "cancelled";
