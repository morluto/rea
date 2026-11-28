import { describe, expect, it } from "vitest";
import {
  createInvestigation,
  addHypothesis,
  addEvidence,
  addGap,
  decideHypothesis,
  resolveGap,
  recordRound,
  confrontation,
  requestStop,
  INVESTIGATION_MAX_ROUNDS_ABSOLUTE,
  INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE,
  INVESTIGATION_MAX_EVIDENCE_ABSOLUTE,
  type InvestigationState,
} from "./investigationLoop.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeState(
  overrides: Partial<Parameters<typeof createInvestigation>[1]> = {},
): InvestigationState {
  return createInvestigation("Does feature X have a timing vulnerability?", {
    maxRounds: 10,
    maxHypotheses: 10,
    maxEvidence: 100,
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// createInvestigation
// ---------------------------------------------------------------------------

describe("createInvestigation", () => {
  it("creates an active investigation with the given goal and budget", () => {
    const state = makeState();
    expect(state.status).toBe("active");
    expect(state.goal).toBe("Does feature X have a timing vulnerability?");
    expect(state.roundsUsed).toBe(0);
    expect(state.hypotheses).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
    expect(state.gaps).toHaveLength(0);
  });

  it("rejects budget values below 1", () => {
    expect(() => makeState({ maxRounds: 0 })).toThrow();
    expect(() => makeState({ maxHypotheses: 0 })).toThrow();
    expect(() => makeState({ maxEvidence: 0 })).toThrow();
  });

  it("rejects budget values that exceed absolute caps", () => {
    expect(() =>
      makeState({ maxRounds: INVESTIGATION_MAX_ROUNDS_ABSOLUTE + 1 }),
    ).toThrow();
    expect(() =>
      makeState({ maxHypotheses: INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE + 1 }),
    ).toThrow();
    expect(() =>
      makeState({ maxEvidence: INVESTIGATION_MAX_EVIDENCE_ABSOLUTE + 1 }),
    ).toThrow();
  });

  it("rejects an empty goal", () => {
    expect(() =>
      createInvestigation("  ", {
        maxRounds: 5,
        maxHypotheses: 5,
        maxEvidence: 5,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// addHypothesis
// ---------------------------------------------------------------------------

describe("addHypothesis", () => {
  it("adds an open hypothesis with a generated id", () => {
    const state = makeState();
    const result = addHypothesis(
      state,
      "The timer callback fires before the lock is taken",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hypotheses).toHaveLength(1);
    expect(result.value.hypotheses[0]!.status).toBe("open");
    expect(result.value.hypotheses[0]!.statement).toBe(
      "The timer callback fires before the lock is taken",
    );
    expect(result.value.hypotheses[0]!.evidenceIds).toHaveLength(0);
  });

  it("rejects an empty statement", () => {
    const state = makeState();
    const result = addHypothesis(state, "   ");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_input");
  });

  it("rejects adding a hypothesis to a closed investigation", () => {
    let state = makeState({ maxRounds: 1 });
    const roundResult = recordRound(state);
    expect(roundResult.ok).toBe(true);
    if (!roundResult.ok) return;
    state = roundResult.value;
    expect(state.status).toBe("budget_exhausted");
    const result = addHypothesis(state, "should fail");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("investigation_closed");
  });

  it("enforces the caller maxHypotheses budget", () => {
    let state = makeState({ maxHypotheses: 2 });
    const r1 = addHypothesis(state, "h1");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.value;
    const r2 = addHypothesis(state, "h2");
    expect(r2.ok).toBe(true);
    if (!r2.ok) return;
    state = r2.value;
    const r3 = addHypothesis(state, "h3 — over budget");
    expect(r3.ok).toBe(false);
    if (r3.ok) return;
    expect(r3.error.kind).toBe("budget_violated");
  });
});

// ---------------------------------------------------------------------------
// addEvidence
// ---------------------------------------------------------------------------

describe("addEvidence", () => {
  it("adds an evidence entry to the ledger", () => {
    const state = makeState();
    const result = addEvidence(state, {
      id: "ev_001",
      summary: "Strace log shows syscall ordering",
      source: "strace output",
      kind: "observation",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ledger).toHaveLength(1);
    expect(result.value.ledger[0]!.id).toBe("ev_001");
  });

  it("generates an id when none is provided", () => {
    const state = makeState();
    const result = addEvidence(state, {
      summary: "Auto-id evidence",
      source: "test",
      kind: "inference",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.ledger[0]!.id).toBeTruthy();
  });

  it("rejects a duplicate evidence id", () => {
    let state = makeState();
    const r1 = addEvidence(state, {
      id: "ev_dup",
      summary: "first",
      source: "s",
      kind: "observation",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.value;
    const r2 = addEvidence(state, {
      id: "ev_dup",
      summary: "second",
      source: "s",
      kind: "observation",
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("invalid_input");
  });

  it("enforces the caller maxEvidence budget", () => {
    let state = makeState({ maxEvidence: 1 });
    const r1 = addEvidence(state, {
      id: "ev_1",
      summary: "one",
      source: "s",
      kind: "observation",
    });
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.value;
    const r2 = addEvidence(state, {
      id: "ev_2",
      summary: "two",
      source: "s",
      kind: "observation",
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("budget_violated");
  });
});

// ---------------------------------------------------------------------------
// addGap
// ---------------------------------------------------------------------------

describe("addGap", () => {
  it("adds an unresolved gap with valid blocking hypothesis ids", () => {
    let state = makeState();
    const hypResult = addHypothesis(state, "some claim");
    expect(hypResult.ok).toBe(true);
    if (!hypResult.ok) return;
    state = hypResult.value;
    const hypId = state.hypotheses[0]!.id;

    const gapResult = addGap(state, "What does the log show?", [hypId]);
    expect(gapResult.ok).toBe(true);
    if (!gapResult.ok) return;
    expect(gapResult.value.gaps).toHaveLength(1);
    expect(gapResult.value.gaps[0]!.resolved).toBe(false);
    expect(gapResult.value.gaps[0]!.blockingHypothesisIds).toContain(hypId);
  });

  it("rejects unknown blocking hypothesis ids", () => {
    const state = makeState();
    const result = addGap(state, "What does the log show?", [
      "hyp_nonexistent",
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_found");
  });

  it("accepts an empty blockingHypothesisIds list", () => {
    const state = makeState();
    const result = addGap(state, "Is the binary stripped?", []);
    expect(result.ok).toBe(true);
  });

  it("rejects an empty question", () => {
    const state = makeState();
    const result = addGap(state, "  ", []);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("invalid_input");
  });
});

// ---------------------------------------------------------------------------
// decideHypothesis
// ---------------------------------------------------------------------------

describe("decideHypothesis", () => {
  function stateWithHypAndEvidence() {
    let state = makeState();
    const hR = addHypothesis(state, "timing window exists");
    expect(hR.ok).toBe(true);
    if (!hR.ok) throw new Error("setup");
    state = hR.value;
    const eR = addEvidence(state, {
      id: "ev_A",
      summary: "log excerpt",
      source: "strace",
      kind: "observation",
    });
    expect(eR.ok).toBe(true);
    if (!eR.ok) throw new Error("setup");
    state = eR.value;
    return { state, hypId: state.hypotheses[0]!.id };
  }

  it("decides a hypothesis as supported when citing ledger evidence", () => {
    const { state, hypId } = stateWithHypAndEvidence();
    const result = decideHypothesis(state, hypId, "supported", ["ev_A"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hyp = result.value.hypotheses.find((h) => h.id === hypId)!;
    expect(hyp.status).toBe("supported");
    expect(hyp.evidenceIds).toContain("ev_A");
  });

  it("decides a hypothesis as refuted when citing ledger evidence", () => {
    const { state, hypId } = stateWithHypAndEvidence();
    const result = decideHypothesis(state, hypId, "refuted", ["ev_A"]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.hypotheses.find((h) => h.id === hypId)!.status).toBe(
      "refuted",
    );
  });

  it("rejects decision when a cited evidence id is not in the ledger", () => {
    const { state, hypId } = stateWithHypAndEvidence();
    const result = decideHypothesis(state, hypId, "supported", ["ev_MISSING"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("evidence_missing");
    if (result.error.kind === "evidence_missing") {
      expect(result.error.missingIds).toContain("ev_MISSING");
    }
  });

  it("rejects decision when hypothesis id is unknown", () => {
    const { state } = stateWithHypAndEvidence();
    const result = decideHypothesis(state, "hyp_ghost", "supported", ["ev_A"]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_found");
  });

  it("rejects deciding an already-decided hypothesis", () => {
    const { state, hypId } = stateWithHypAndEvidence();
    const r1 = decideHypothesis(state, hypId, "supported", ["ev_A"]);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = decideHypothesis(r1.value, hypId, "refuted", ["ev_A"]);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("already_decided");
  });
});

// ---------------------------------------------------------------------------
// resolveGap
// ---------------------------------------------------------------------------

describe("resolveGap", () => {
  function stateWithGapAndEvidence() {
    let state = makeState();
    const eR = addEvidence(state, {
      id: "ev_B",
      summary: "binary is not stripped",
      source: "file(1)",
      kind: "observation",
    });
    expect(eR.ok).toBe(true);
    if (!eR.ok) throw new Error("setup");
    state = eR.value;
    const gR = addGap(state, "Is the binary stripped?", []);
    expect(gR.ok).toBe(true);
    if (!gR.ok) throw new Error("setup");
    state = gR.value;
    return { state, gapId: state.gaps[0]!.id };
  }

  it("resolves a gap by citing a ledger evidence id", () => {
    const { state, gapId } = stateWithGapAndEvidence();
    const result = resolveGap(state, gapId, "ev_B");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const gap = result.value.gaps.find((g) => g.id === gapId)!;
    expect(gap.resolved).toBe(true);
    expect(gap.resolvingEvidenceId).toBe("ev_B");
  });

  it("rejects resolution when the evidence id is not in the ledger", () => {
    const { state, gapId } = stateWithGapAndEvidence();
    const result = resolveGap(state, gapId, "ev_MISSING");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("evidence_missing");
  });

  it("rejects resolving a gap that is already resolved", () => {
    const { state, gapId } = stateWithGapAndEvidence();
    const r1 = resolveGap(state, gapId, "ev_B");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = resolveGap(r1.value, gapId, "ev_B");
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("already_resolved");
  });

  it("rejects an unknown gap id", () => {
    const { state } = stateWithGapAndEvidence();
    const result = resolveGap(state, "gap_ghost", "ev_B");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// recordRound
// ---------------------------------------------------------------------------

describe("recordRound", () => {
  it("increments the round counter", () => {
    const state = makeState({ maxRounds: 5 });
    const result = recordRound(state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundsUsed).toBe(1);
    expect(result.value.status).toBe("active");
  });

  it("closes with budget_exhausted when maxRounds is reached", () => {
    let state = makeState({ maxRounds: 1 });
    const result = recordRound(state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundsUsed).toBe(1);
    expect(result.value.status).toBe("budget_exhausted");
  });

  it("fails when the investigation is already closed", () => {
    let state = makeState({ maxRounds: 1 });
    const r1 = recordRound(state);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.value;
    const r2 = recordRound(state);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("investigation_closed");
  });
});

// ---------------------------------------------------------------------------
// confrontation
// ---------------------------------------------------------------------------

describe("confrontation", () => {
  it("returns open hypotheses and gaps only", () => {
    let state = makeState();
    const hR = addHypothesis(state, "open claim");
    expect(hR.ok).toBe(true);
    if (!hR.ok) return;
    state = hR.value;
    const eR = addEvidence(state, {
      id: "ev_C",
      summary: "log",
      source: "s",
      kind: "derivation",
    });
    expect(eR.ok).toBe(true);
    if (!eR.ok) return;
    state = eR.value;
    const gR = addGap(state, "open gap question", []);
    expect(gR.ok).toBe(true);
    if (!gR.ok) return;
    state = gR.value;

    const hypId = state.hypotheses[0]!.id;
    const dR = decideHypothesis(state, hypId, "supported", ["ev_C"]);
    expect(dR.ok).toBe(true);
    if (!dR.ok) return;
    // now hypothesis is decided, gap is still open

    const report = confrontation(dR.value);
    expect(report.openHypotheses).toHaveLength(0);
    expect(report.openGaps).toHaveLength(1);
    expect(report.openGaps[0]!.question).toBe("open gap question");
  });

  it("returns empty arrays when everything is decided and resolved", () => {
    let state = makeState();
    const hR = addHypothesis(state, "claim");
    expect(hR.ok).toBe(true);
    if (!hR.ok) return;
    state = hR.value;
    const hypId = state.hypotheses[0]!.id;

    const eR = addEvidence(state, {
      id: "ev_D",
      summary: "data",
      source: "s",
      kind: "inference",
    });
    expect(eR.ok).toBe(true);
    if (!eR.ok) return;
    state = eR.value;

    const dR = decideHypothesis(state, hypId, "supported", ["ev_D"]);
    expect(dR.ok).toBe(true);
    if (!dR.ok) return;
    state = dR.value;

    const report = confrontation(state);
    expect(report.openHypotheses).toHaveLength(0);
    expect(report.openGaps).toHaveLength(0);
  });

  it("reports only ids and statements — not full evidence bodies", () => {
    let state = makeState();
    const hR = addHypothesis(state, "some open claim");
    expect(hR.ok).toBe(true);
    if (!hR.ok) return;
    state = hR.value;

    const report = confrontation(state);
    const hyp = report.openHypotheses[0]!;
    expect(Object.keys(hyp)).toEqual(["id", "statement"]);
  });
});

// ---------------------------------------------------------------------------
// requestStop
// ---------------------------------------------------------------------------

describe("requestStop", () => {
  it("blocks goal_answered while a hypothesis is open", () => {
    let state = makeState();
    const hR = addHypothesis(state, "undecided");
    expect(hR.ok).toBe(true);
    if (!hR.ok) return;
    state = hR.value;

    const result = requestStop(state, "goal_answered");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("open_items_remain");
  });

  it("blocks goal_answered while a gap is open", () => {
    let state = makeState();
    const gR = addGap(state, "unresolved question", []);
    expect(gR.ok).toBe(true);
    if (!gR.ok) return;
    state = gR.value;

    const result = requestStop(state, "goal_answered");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("open_items_remain");
  });

  it("allows goal_answered when all hypotheses are decided and all gaps are resolved", () => {
    let state = makeState();
    const hR = addHypothesis(state, "claim");
    expect(hR.ok).toBe(true);
    if (!hR.ok) return;
    state = hR.value;
    const hypId = state.hypotheses[0]!.id;

    const eR = addEvidence(state, {
      id: "ev_E",
      summary: "data",
      source: "s",
      kind: "observation",
    });
    expect(eR.ok).toBe(true);
    if (!eR.ok) return;
    state = eR.value;

    const gR = addGap(state, "open question", []);
    expect(gR.ok).toBe(true);
    if (!gR.ok) return;
    state = gR.value;
    const gapId = state.gaps[0]!.id;

    const dR = decideHypothesis(state, hypId, "refuted", ["ev_E"]);
    expect(dR.ok).toBe(true);
    if (!dR.ok) return;
    state = dR.value;

    const rR = resolveGap(state, gapId, "ev_E");
    expect(rR.ok).toBe(true);
    if (!rR.ok) return;
    state = rR.value;

    const stopResult = requestStop(state, "goal_answered");
    expect(stopResult.ok).toBe(true);
    if (!stopResult.ok) return;
    expect(stopResult.value.status).toBe("goal_answered");
  });

  it("allows abandoned with open items — they remain visible", () => {
    let state = makeState();
    const hR = addHypothesis(state, "still open");
    expect(hR.ok).toBe(true);
    if (!hR.ok) return;
    state = hR.value;

    const result = requestStop(state, "abandoned");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.status).toBe("abandoned");
    // open item preserved in the record
    expect(result.value.hypotheses[0]!.status).toBe("open");
  });

  it("fails when the investigation is already closed", () => {
    let state = makeState({ maxRounds: 1 });
    const rR = recordRound(state);
    expect(rR.ok).toBe(true);
    if (!rR.ok) return;
    state = rR.value;

    const result = requestStop(state, "abandoned");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("investigation_closed");
  });
});
