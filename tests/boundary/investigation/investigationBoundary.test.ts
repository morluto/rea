/**
 * Boundary tests for the investigation-loop domain module.
 *
 * Covers: exact-cap acceptance, over-cap rejection, minimum-limit violations,
 * absolute-cap violations, stopping on the first round (max_rounds=1), and a
 * two-round investigation with 2 hypotheses decided and 1 gap resolved.
 */

import { describe, expect, it } from "vitest";
import {
  createInvestigation,
  addHypothesis,
  addEvidence,
  addGap,
  decideHypothesis,
  resolveGap,
  recordRound,
  requestStop,
  INVESTIGATION_MAX_ROUNDS_ABSOLUTE,
  INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE,
  INVESTIGATION_MAX_EVIDENCE_ABSOLUTE,
} from "../../../src/domain/investigation/investigationLoop.js";

// ---------------------------------------------------------------------------
// 1. Exact-cap acceptance
// ---------------------------------------------------------------------------

describe("exact-cap acceptance", () => {
  it("accepts budget values at the absolute caps", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: INVESTIGATION_MAX_ROUNDS_ABSOLUTE,
        maxHypotheses: INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE,
        maxEvidence: INVESTIGATION_MAX_EVIDENCE_ABSOLUTE,
      }),
    ).not.toThrow();
  });

  it("accepts budget values at the minimum of 1", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 1,
        maxHypotheses: 1,
        maxEvidence: 1,
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Over-cap rejection
// ---------------------------------------------------------------------------

describe("over-cap rejection", () => {
  it("rejects maxRounds above the absolute cap", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: INVESTIGATION_MAX_ROUNDS_ABSOLUTE + 1,
        maxHypotheses: 10,
        maxEvidence: 10,
      }),
    ).toThrow();
  });

  it("rejects maxHypotheses above the absolute cap", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 10,
        maxHypotheses: INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE + 1,
        maxEvidence: 10,
      }),
    ).toThrow();
  });

  it("rejects maxEvidence above the absolute cap", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 10,
        maxHypotheses: 10,
        maxEvidence: INVESTIGATION_MAX_EVIDENCE_ABSOLUTE + 1,
      }),
    ).toThrow();
  });

  it("rejects adding a hypothesis beyond the caller budget", () => {
    let state = createInvestigation("goal", {
      maxRounds: 10,
      maxHypotheses: 1,
      maxEvidence: 10,
    });
    const r1 = addHypothesis(state, "h1");
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    state = r1.value;
    const r2 = addHypothesis(state, "h2 over");
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("budget_violated");
  });

  it("rejects adding evidence beyond the caller budget", () => {
    let state = createInvestigation("goal", {
      maxRounds: 10,
      maxHypotheses: 10,
      maxEvidence: 1,
    });
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
      summary: "two over",
      source: "s",
      kind: "observation",
    });
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("budget_violated");
  });
});

// ---------------------------------------------------------------------------
// 3. Minimum-limit violations
// ---------------------------------------------------------------------------

describe("minimum-limit violations", () => {
  it("rejects maxRounds = 0", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 0,
        maxHypotheses: 1,
        maxEvidence: 1,
      }),
    ).toThrow();
  });

  it("rejects maxHypotheses = 0", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 1,
        maxHypotheses: 0,
        maxEvidence: 1,
      }),
    ).toThrow();
  });

  it("rejects maxEvidence = 0", () => {
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 1,
        maxHypotheses: 1,
        maxEvidence: 0,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 4. Absolute-cap violations (redundant with schema, belt-and-suspenders)
// ---------------------------------------------------------------------------

describe("absolute-cap violations", () => {
  it("absolute round cap is 1000", () => {
    expect(INVESTIGATION_MAX_ROUNDS_ABSOLUTE).toBe(1000);
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 1001,
        maxHypotheses: 1,
        maxEvidence: 1,
      }),
    ).toThrow();
  });

  it("absolute hypothesis cap is 1000", () => {
    expect(INVESTIGATION_MAX_HYPOTHESES_ABSOLUTE).toBe(1000);
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 1,
        maxHypotheses: 1001,
        maxEvidence: 1,
      }),
    ).toThrow();
  });

  it("absolute evidence cap is 10000", () => {
    expect(INVESTIGATION_MAX_EVIDENCE_ABSOLUTE).toBe(10_000);
    expect(() =>
      createInvestigation("goal", {
        maxRounds: 1,
        maxHypotheses: 1,
        maxEvidence: 10_001,
      }),
    ).toThrow();
  });
});

// ---------------------------------------------------------------------------
// 5. Stopping on the first round when max_rounds = 1
// ---------------------------------------------------------------------------

describe("stopping on the first round when max_rounds = 1", () => {
  it("closes the investigation after a single recordRound call", () => {
    const state = createInvestigation("goal", {
      maxRounds: 1,
      maxHypotheses: 10,
      maxEvidence: 10,
    });
    const result = recordRound(state);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.roundsUsed).toBe(1);
    expect(result.value.status).toBe("budget_exhausted");
  });

  it("rejects a second recordRound after budget_exhausted", () => {
    const state = createInvestigation("goal", {
      maxRounds: 1,
      maxHypotheses: 10,
      maxEvidence: 10,
    });
    const r1 = recordRound(state);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const r2 = recordRound(r1.value);
    expect(r2.ok).toBe(false);
    if (r2.ok) return;
    expect(r2.error.kind).toBe("investigation_closed");
  });
});

// ---------------------------------------------------------------------------
// 6. Two-round investigation: 2 hypotheses decided, 1 gap resolved → goal_answered
// ---------------------------------------------------------------------------

describe("two-round investigation reaching goal_answered", () => {
  it("allows goal_answered once all hypotheses are decided and gaps resolved", () => {
    let state = createInvestigation(
      "Does the network handler retry on EAGAIN?",
      { maxRounds: 5, maxHypotheses: 5, maxEvidence: 20 },
    );

    // Round 1 — add hypotheses, add initial evidence, decide hyp1
    const h1R = addHypothesis(state, "The handler calls recv() in a loop");
    expect(h1R.ok).toBe(true);
    if (!h1R.ok) return;
    state = h1R.value;

    const h2R = addHypothesis(state, "EAGAIN causes an immediate retry");
    expect(h2R.ok).toBe(true);
    if (!h2R.ok) return;
    state = h2R.value;

    const e1R = addEvidence(state, {
      id: "ev_r1",
      summary: "disassembly shows loop structure",
      source: "Ghidra",
      kind: "observation",
    });
    expect(e1R.ok).toBe(true);
    if (!e1R.ok) return;
    state = e1R.value;

    const hypId1 = state.hypotheses[0]!.id;
    const d1R = decideHypothesis(state, hypId1, "supported", ["ev_r1"]);
    expect(d1R.ok).toBe(true);
    if (!d1R.ok) return;
    state = d1R.value;

    const gR = addGap(state, "What is the errno check path?", [
      state.hypotheses[1]!.id,
    ]);
    expect(gR.ok).toBe(true);
    if (!gR.ok) return;
    state = gR.value;
    const gapId = state.gaps[0]!.id;

    // goal_answered blocked — hyp2 open, gap open
    const blocked1 = requestStop(state, "goal_answered");
    expect(blocked1.ok).toBe(false);

    const round1R = recordRound(state);
    expect(round1R.ok).toBe(true);
    if (!round1R.ok) return;
    state = round1R.value;
    expect(state.status).toBe("active");

    // Round 2 — add evidence, decide hyp2, resolve gap
    const e2R = addEvidence(state, {
      id: "ev_r2",
      summary: "errno branch decompiled",
      source: "Ghidra",
      kind: "derivation",
    });
    expect(e2R.ok).toBe(true);
    if (!e2R.ok) return;
    state = e2R.value;

    const hypId2 = state.hypotheses[1]!.id;
    const d2R = decideHypothesis(state, hypId2, "supported", ["ev_r2"]);
    expect(d2R.ok).toBe(true);
    if (!d2R.ok) return;
    state = d2R.value;

    const rgR = resolveGap(state, gapId, "ev_r2");
    expect(rgR.ok).toBe(true);
    if (!rgR.ok) return;
    state = rgR.value;

    const round2R = recordRound(state);
    expect(round2R.ok).toBe(true);
    if (!round2R.ok) return;
    state = round2R.value;
    expect(state.roundsUsed).toBe(2);

    // Now goal_answered must succeed
    const stopR = requestStop(state, "goal_answered");
    expect(stopR.ok).toBe(true);
    if (!stopR.ok) return;
    expect(stopR.value.status).toBe("goal_answered");
    expect(stopR.value.hypotheses.every((h) => h.status !== "open")).toBe(true);
    expect(stopR.value.gaps.every((g) => g.resolved)).toBe(true);
  });
});
