/**
 * Investigation-loop construct for agent-driven deep dives (Phase 1).
 *
 * Pure domain module: state + enforcement only. No tool execution, no MCP
 * wiring, no persistence, and no autonomous round-driving. The driving agent
 * still calls tools and reports back; this module records what an investigation
 * set out to prove, what it has established, and what is still unproven — and
 * confronts the agent with its own unfinished work before it can declare done.
 *
 * State is data, not a live session. Every function takes an InvestigationState
 * and returns a new validated state or a typed Result.
 */

import { z } from "zod";
import { ok, err, type Result } from "../result.js";

// ---------------------------------------------------------------------------
// Absolute caps — not caller-settable
// ---------------------------------------------------------------------------

export const INVESTIGATION_MAX_ROUNDS_ABSOLUTE = 1000;
export const INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE = 1000;
export const INVESTIGATION_MAX_EVIDENCE_ABSOLUTE = 10_000;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

export const hypothesisStatusSchema = z.enum(["open", "supported", "refuted"]);
export type HypothesisStatus = z.infer<typeof hypothesisStatusSchema>;

export const evidenceKindSchema = z.enum([
  "observation",
  "derivation",
  "inference",
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

export const stopReasonSchema = z.enum([
  "goal_answered",
  "abandoned",
  "budget_exhausted",
]);
export type StopReason = z.infer<typeof stopReasonSchema>;

export const investigationStatusSchema = z.enum([
  "active",
  "goal_answered",
  "abandoned",
  "budget_exhausted",
]);
export type InvestigationStatus = z.infer<typeof investigationStatusSchema>;

const nonEmptyString = z.string().trim().min(1);

export const hypothesisSchema = z.strictObject({
  id: nonEmptyString,
  statement: nonEmptyString,
  status: hypothesisStatusSchema,
  /** Evidence ids that decided this hypothesis (empty while open). */
  evidenceIds: z.array(nonEmptyString),
});
export type Hypothesis = z.infer<typeof hypothesisSchema>;

export const evidenceLedgerEntrySchema = z.strictObject({
  /** Stable id for this entry; cited by hypotheses and gaps. */
  id: nonEmptyString,
  /** One-line description; full evidence lives behind the id, not here. */
  summary: nonEmptyString,
  /** Where this evidence came from. */
  source: nonEmptyString,
  kind: evidenceKindSchema,
});
export type EvidenceLedgerEntry = z.infer<typeof evidenceLedgerEntrySchema>;

export const gapSchema = z.strictObject({
  id: nonEmptyString,
  question: nonEmptyString,
  /** Hypothesis ids this gap is blocking. */
  blockingHypothesisIds: z.array(nonEmptyString),
  resolved: z.boolean(),
  /** The ledger evidence id that resolved this gap, if resolved. */
  resolvingEvidenceId: nonEmptyString.optional(),
});
export type Gap = z.infer<typeof gapSchema>;

export const depthBudgetSchema = z.strictObject({
  maxRounds: z.number().int().min(1).max(INVESTIGATION_MAX_ROUNDS_ABSOLUTE),
  maxHypotheses: z
    .number()
    .int()
    .min(1)
    .max(INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE),
  maxEvidence: z.number().int().min(1).max(INVESTIGATION_MAX_EVIDENCE_ABSOLUTE),
});
export type DepthBudget = z.infer<typeof depthBudgetSchema>;

export const investigationStateSchema = z.strictObject({
  goal: nonEmptyString,
  hypotheses: z.array(hypothesisSchema),
  /** Ledger entries; full evidence bodies live behind their ids. */
  ledger: z.array(evidenceLedgerEntrySchema),
  gaps: z.array(gapSchema),
  budget: depthBudgetSchema,
  roundsUsed: z.number().int().min(0),
  status: investigationStatusSchema,
});
export type InvestigationState = z.infer<typeof investigationStateSchema>;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type InvestigationError =
  | { readonly kind: "budget_violated"; readonly message: string }
  | {
      readonly kind: "evidence_missing";
      readonly message: string;
      readonly missingIds: string[];
    }
  | {
      readonly kind: "not_found";
      readonly message: string;
      readonly id: string;
    }
  | {
      readonly kind: "already_decided";
      readonly message: string;
      readonly id: string;
    }
  | {
      readonly kind: "already_resolved";
      readonly message: string;
      readonly id: string;
    }
  | {
      readonly kind: "open_items_remain";
      readonly message: string;
      readonly openHypothesisIds: string[];
      readonly openGapIds: string[];
    }
  | {
      readonly kind: "investigation_closed";
      readonly message: string;
      readonly status: InvestigationStatus;
    }
  | { readonly kind: "invalid_input"; readonly message: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function assertActive(
  state: InvestigationState,
): Result<void, InvestigationError> {
  if (state.status !== "active") {
    return err({
      kind: "investigation_closed",
      message: `Investigation is already closed with status "${state.status}".`,
      status: state.status,
    });
  }
  return ok(undefined);
}

let _nextSeq = 0;
function nextId(prefix: string): string {
  return `${prefix}_${Date.now()}_${(_nextSeq++).toString(36)}`;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

/**
 * Create a new active investigation.
 *
 * @throws zod parse error when budget values violate the schema (e.g. exceed
 *   absolute caps or are below 1).
 */
export function createInvestigation(
  goal: string,
  budget: DepthBudget,
): InvestigationState {
  const parsedBudget = depthBudgetSchema.parse(budget);
  const parsedGoal = z.string().trim().min(1).parse(goal);
  return investigationStateSchema.parse({
    goal: parsedGoal,
    hypotheses: [],
    ledger: [],
    gaps: [],
    budget: parsedBudget,
    roundsUsed: 0,
    status: "active",
  });
}

/**
 * Add a new open hypothesis.
 *
 * Fails when:
 * - investigation is closed
 * - adding it would exceed `maxHypotheses` or the absolute cap
 */
export function addHypothesis(
  state: InvestigationState,
  statement: string,
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  const trimmed = statement.trim();
  if (trimmed.length === 0) {
    return err({
      kind: "invalid_input",
      message: "Hypothesis statement must not be empty.",
    });
  }

  const newCount = state.hypotheses.length + 1;
  if (newCount > INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE) {
    return err({
      kind: "budget_violated",
      message: `Absolute hypothesis cap of ${INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE} exceeded.`,
    });
  }
  if (newCount > state.budget.maxHypotheses) {
    return err({
      kind: "budget_violated",
      message: `Hypothesis budget of ${state.budget.maxHypotheses} exceeded.`,
    });
  }

  const hypothesis: Hypothesis = {
    id: nextId("hyp"),
    statement: trimmed,
    status: "open",
    evidenceIds: [],
  };

  return ok({ ...state, hypotheses: [...state.hypotheses, hypothesis] });
}

/**
 * Add an evidence ledger entry.
 *
 * Fails when:
 * - investigation is closed
 * - adding it would exceed `maxEvidence` or the absolute cap
 * - an entry with the same id already exists
 */
export function addEvidence(
  state: InvestigationState,
  entry: Omit<EvidenceLedgerEntry, "id"> & { id?: string },
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  const newCount = state.ledger.length + 1;
  if (newCount > INVESTIGATION_MAX_EVIDENCE_ABSOLUTE) {
    return err({
      kind: "budget_violated",
      message: `Absolute evidence cap of ${INVESTIGATION_MAX_EVIDENCE_ABSOLUTE} exceeded.`,
    });
  }
  if (newCount > state.budget.maxEvidence) {
    return err({
      kind: "budget_violated",
      message: `Evidence budget of ${state.budget.maxEvidence} exceeded.`,
    });
  }

  const id = entry.id?.trim() ?? nextId("ev");
  if (!id) {
    return err({
      kind: "invalid_input",
      message: "Evidence id must not be empty.",
    });
  }
  if (state.ledger.some((e) => e.id === id)) {
    return err({
      kind: "invalid_input",
      message: `Evidence id "${id}" already exists in ledger.`,
    });
  }

  const parsed = evidenceLedgerEntrySchema.safeParse({ ...entry, id });
  if (!parsed.success) {
    return err({ kind: "invalid_input", message: parsed.error.message });
  }

  return ok({ ...state, ledger: [...state.ledger, parsed.data] });
}

/**
 * Add an open gap (unanswered question).
 *
 * Fails when:
 * - investigation is closed
 * - any of the `blockingHypothesisIds` does not refer to a known hypothesis
 */
export function addGap(
  state: InvestigationState,
  question: string,
  blockingHypothesisIds: string[],
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return err({
      kind: "invalid_input",
      message: "Gap question must not be empty.",
    });
  }

  const knownIds = new Set(state.hypotheses.map((h) => h.id));
  const missing = blockingHypothesisIds.filter((id) => !knownIds.has(id));
  if (missing.length > 0) {
    return err({
      kind: "not_found",
      message: `Unknown hypothesis ids in blockingHypothesisIds: ${missing.join(", ")}`,
      id: missing[0]!,
    });
  }

  const gap: Gap = {
    id: nextId("gap"),
    question: trimmed,
    blockingHypothesisIds: [...blockingHypothesisIds],
    resolved: false,
  };

  return ok({ ...state, gaps: [...state.gaps, gap] });
}

/**
 * Decide a hypothesis as supported or refuted, citing evidence.
 *
 * **Enforcement rule**: every id in `evidenceIds` must already exist in the
 * ledger. No evidence → no decision. An agent cannot hand-wave a hypothesis.
 *
 * Fails when:
 * - investigation is closed
 * - hypothesis id not found
 * - hypothesis is already decided
 * - any cited evidence id is missing from the ledger
 */
export function decideHypothesis(
  state: InvestigationState,
  hypothesisId: string,
  verdict: "supported" | "refuted",
  evidenceIds: string[],
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  const hypothesis = state.hypotheses.find((h) => h.id === hypothesisId);
  if (!hypothesis) {
    return err({
      kind: "not_found",
      message: `Hypothesis "${hypothesisId}" not found.`,
      id: hypothesisId,
    });
  }
  if (hypothesis.status !== "open") {
    return err({
      kind: "already_decided",
      message: `Hypothesis "${hypothesisId}" is already "${hypothesis.status}".`,
      id: hypothesisId,
    });
  }

  const ledgerIds = new Set(state.ledger.map((e) => e.id));
  const missing = evidenceIds.filter((id) => !ledgerIds.has(id));
  if (missing.length > 0) {
    return err({
      kind: "evidence_missing",
      message: `Cannot decide hypothesis "${hypothesisId}": evidence ids not in ledger: ${missing.join(", ")}`,
      missingIds: missing,
    });
  }

  const updated: Hypothesis = {
    ...hypothesis,
    status: verdict,
    evidenceIds: [...evidenceIds],
  };
  return ok({
    ...state,
    hypotheses: state.hypotheses.map((h) =>
      h.id === hypothesisId ? updated : h,
    ),
  });
}

/**
 * Resolve a gap by citing a ledger evidence id.
 *
 * **Enforcement rule**: the resolving evidence id must already be in the ledger.
 *
 * Fails when:
 * - investigation is closed
 * - gap id not found
 * - gap is already resolved
 * - cited evidence id is missing from the ledger
 */
export function resolveGap(
  state: InvestigationState,
  gapId: string,
  evidenceId: string,
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  const gap = state.gaps.find((g) => g.id === gapId);
  if (!gap) {
    return err({
      kind: "not_found",
      message: `Gap "${gapId}" not found.`,
      id: gapId,
    });
  }
  if (gap.resolved) {
    return err({
      kind: "already_resolved",
      message: `Gap "${gapId}" is already resolved.`,
      id: gapId,
    });
  }

  const inLedger = state.ledger.some((e) => e.id === evidenceId);
  if (!inLedger) {
    return err({
      kind: "evidence_missing",
      message: `Cannot resolve gap "${gapId}": evidence id "${evidenceId}" not in ledger.`,
      missingIds: [evidenceId],
    });
  }

  const updated: Gap = {
    ...gap,
    resolved: true,
    resolvingEvidenceId: evidenceId,
  };
  return ok({
    ...state,
    gaps: state.gaps.map((g) => (g.id === gapId ? updated : g)),
  });
}

/**
 * Record that one round of investigation has completed.
 *
 * When the new round count reaches `maxRounds` the investigation is closed
 * with status `"budget_exhausted"` rather than throwing. The round counter
 * still increments to preserve the accurate count.
 *
 * Fails when:
 * - investigation is already closed
 */
export function recordRound(
  state: InvestigationState,
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  const roundsUsed = state.roundsUsed + 1;
  const status: InvestigationStatus =
    roundsUsed >= state.budget.maxRounds ? "budget_exhausted" : "active";

  return ok({ ...state, roundsUsed, status });
}

/**
 * Return exactly what is still unproven — ids and short statements only, never
 * full evidence bodies — so confronting the agent costs few tokens.
 */
export function confrontation(state: InvestigationState): {
  readonly openHypotheses: ReadonlyArray<{
    readonly id: string;
    readonly statement: string;
  }>;
  readonly openGaps: ReadonlyArray<{
    readonly id: string;
    readonly question: string;
  }>;
} {
  return {
    openHypotheses: state.hypotheses
      .filter((h) => h.status === "open")
      .map(({ id, statement }) => ({ id, statement })),
    openGaps: state.gaps
      .filter((g) => !g.resolved)
      .map(({ id, question }) => ({ id, question })),
  };
}

/**
 * Request the investigation stop.
 *
 * **Enforcement rule for `"goal_answered"`**: throws (returns error) while any
 * hypothesis is undecided or any gap is open. The only way to stop with open
 * items is `"abandoned"`, which leaves them visible in the record.
 *
 * Fails when:
 * - investigation is already closed
 * - reason is `"goal_answered"` and open items remain
 */
export function requestStop(
  state: InvestigationState,
  reason: StopReason,
): Result<InvestigationState, InvestigationError> {
  const activeResult = assertActive(state);
  if (!activeResult.ok) return activeResult;

  if (reason === "goal_answered") {
    const open = confrontation(state);
    const openHypothesisIds = open.openHypotheses.map((h) => h.id);
    const openGapIds = open.openGaps.map((g) => g.id);

    if (openHypothesisIds.length > 0 || openGapIds.length > 0) {
      return err({
        kind: "open_items_remain",
        message:
          `Cannot stop with "goal_answered" while ${openHypothesisIds.length} hypothesis(es) are undecided` +
          ` and ${openGapIds.length} gap(s) are unresolved.`,
        openHypothesisIds,
        openGapIds,
      });
    }
  }

  return ok({ ...state, status: reason });
}
