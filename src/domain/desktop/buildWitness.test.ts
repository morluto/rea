import { describe, expect, it } from "vitest";

import {
  admitWitnessStage,
  appStateViews,
  stageVerdict,
  type WitnessActionLog,
  type WitnessStageRecord,
} from "./buildWitness.js";
import type { ComputerAction } from "./computerActions.js";

type Logged = {
  readonly action: ComputerAction;
  readonly outcome: "applied" | "refused" | "failed";
};

const action = (
  name: ComputerAction,
  outcome: Logged["outcome"] = "applied",
): Logged => ({ action: name, outcome });

/** The log the witness reads of these actions, in order: their count and the last applied of each kind. */
const logOf = (actions: readonly Logged[]): WitnessActionLog => ({
  total: actions.length,
  lastApplied: Object.fromEntries(
    actions.flatMap(({ action: name, outcome }, index) =>
      outcome === "applied" ? [[name, index]] : [],
    ),
  ),
});

const admit = (
  stages: readonly WitnessStageRecord[],
  stage: WitnessStageRecord["stage"],
  actions: readonly Logged[],
) => admitWitnessStage(stages, stage, logOf(actions));

const staged = (
  stage: WitnessStageRecord["stage"],
  actionsBefore: number,
): WitnessStageRecord => ({
  stage,
  actions_before: actionsBefore,
  checked_at: "2026-11-05T00:00:00.000Z",
  expectation: stage === "after_edit" ? "all_pass" : "some_fail",
  held: true,
  results: [],
});

describe("build witness rules", () => {
  it("expects a failing check on the seed, after the near miss and after reset, and every check passing after the edit", () => {
    const failing = [
      { id: "a", passed: true, description: "" },
      { id: "b", passed: false, description: "" },
    ];
    const passing = [{ id: "a", passed: true, description: "" }];
    expect(stageVerdict("seed", failing)).toBe("held");
    expect(stageVerdict("seed", passing)).toBe("not_held");
    expect(stageVerdict("after_edit", passing)).toBe("held");
    expect(stageVerdict("after_edit", failing)).toBe("not_held");
    expect(stageVerdict("after_edit", [])).toBe("not_held");
    expect(stageVerdict("near_miss", failing)).toBe("held");
    expect(stageVerdict("near_miss", passing)).toBe("not_held");
    const seed = [{ ...staged("seed", 0), results: failing }];
    expect(stageVerdict("after_reset", failing, seed)).toBe("held");
    expect(stageVerdict("after_reset", passing, seed)).toBe("not_held");
  });

  it("holds after reset only when each check comes out as it did on the seed", () => {
    const outcome = (id: string, passed: boolean) => ({
      id,
      passed,
      description: "",
    });
    const seed = [
      {
        ...staged("seed", 0),
        results: [outcome("eggs", false), outcome("no-egg", true)],
      },
    ];
    expect(
      stageVerdict(
        "after_reset",
        [outcome("eggs", false), outcome("no-egg", true)],
        seed,
      ),
    ).toBe("held");
    // A reset that left the near miss fails a check, but not as the seed did.
    expect(
      stageVerdict(
        "after_reset",
        [outcome("eggs", false), outcome("no-egg", false)],
        seed,
      ),
    ).toBe("not_held");
    // A view unread after the reset cannot show the difference.
    expect(
      stageVerdict(
        "after_reset",
        [
          outcome("eggs", false),
          { ...outcome("no-egg", false), undecided: true as const },
        ],
        seed,
      ),
    ).toBe("undecided");
  });

  it("takes no unreadable or partial view as a failure, leaving a stage it alone would settle undecided", () => {
    const unread = {
      id: "u",
      passed: false,
      description: "",
      undecided: true as const,
    };
    const passing = { id: "a", passed: true, description: "" };
    const failing = { id: "b", passed: false, description: "" };
    const seed = [
      { ...staged("seed", 0), results: [passing, unread, failing] },
    ];
    for (const stage of ["seed", "near_miss"] as const) {
      expect(stageVerdict(stage, [passing, unread], seed)).toBe("undecided");
      expect(stageVerdict(stage, [unread, failing], seed)).toBe("held");
    }
    // after_reset must read every check. An unread one does not match the seed.
    expect(stageVerdict("after_reset", [passing, unread], seed)).toBe(
      "undecided",
    );
    expect(stageVerdict("after_reset", [unread, failing], seed)).toBe(
      "undecided",
    );
    expect(stageVerdict("after_edit", [passing, unread])).toBe("undecided");
    expect(stageVerdict("after_edit", [unread, failing])).toBe("not_held");
  });

  it("takes the stages in order, each after the actions it follows", () => {
    expect(admit([], "seed", [])).toEqual({ ok: true, value: 0 });
    expect(admit([], "after_edit", [])).toMatchObject({
      ok: false,
      error: expect.stringContaining("seed"),
    });
    const seed = [staged("seed", 1)];
    const log = [action("screenshot")];
    // Only looking and waiting since the seed is no edit.
    expect(
      admit(seed, "after_edit", [
        ...log,
        action("screenshot"),
        action("wait"),
        action("type", "refused"),
      ]),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("act on the app"),
    });
    expect(admit(seed, "after_edit", [...log, action("type")])).toEqual({
      ok: true,
      value: 2,
    });
    expect(admit(seed, "seed", log)).toMatchObject({
      ok: false,
      error: expect.stringContaining("after_edit"),
    });
    const edited = [...seed, staged("after_edit", 2)];
    const nearMiss = [...edited, staged("near_miss", 4)];
    const acted = [action("screenshot"), action("type"), action("key")];
    expect(admit(edited, "near_miss", [...acted, action("key")])).toMatchObject(
      { ok: true },
    );
    // A reset must be the last change before the check after it.
    expect(
      admit(nearMiss, "after_reset", [...acted, action("key"), action("type")]),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("reset"),
    });
    expect(
      admit(nearMiss, "after_reset", [
        ...acted,
        action("key"),
        action("reset"),
        action("type"),
      ]),
    ).toMatchObject({ ok: false });
    expect(
      admit(nearMiss, "after_reset", [
        ...acted,
        action("key"),
        action("reset"),
        action("screenshot"),
      ]),
    ).toMatchObject({ ok: true });
    expect(
      admit([...nearMiss, staged("after_reset", 6)], "after_reset", []),
    ).toMatchObject({ ok: false, error: expect.stringContaining("ended") });
  });
});

describe("build witness reset compared with an unreadable seed", () => {
  it("leaves after_reset undecided when an unreadable seed check later passes", () => {
    const unread = {
      id: "note",
      passed: false,
      description: "",
      undecided: true as const,
    };
    const failing = { id: "eggs", passed: false, description: "" };
    const seed = [{ ...staged("seed", 0), results: [unread, failing] }];
    const passed = { id: "note", passed: true, description: "" };
    const eggsPass = { id: "eggs", passed: true, description: "" };
    expect(stageVerdict("after_reset", [passed, failing], seed)).toBe(
      "undecided",
    );
    expect(stageVerdict("after_reset", [unread, failing], seed)).toBe(
      "undecided",
    );
    expect(stageVerdict("after_reset", [passed, eggsPass], seed)).toBe(
      "not_held",
    );
  });
});

describe("build witness unread reset", () => {
  it("stays undecided when a decided seed failure is unreadable after the reset and another check still fails", () => {
    const seedFailure = { id: "a", passed: false, description: "" };
    const stillFailing = { id: "b", passed: false, description: "" };
    const unreadAfter = { ...seedFailure, undecided: true as const };
    const restored = { id: "a", passed: true, description: "" };
    const unreadOther = { ...stillFailing, undecided: true as const };
    const seed = [
      { ...staged("seed", 0), results: [seedFailure, stillFailing] },
    ];
    expect(stageVerdict("after_reset", [unreadAfter, stillFailing], seed)).toBe(
      "undecided",
    );
    expect(stageVerdict("after_reset", [restored, unreadOther], seed)).toBe(
      "not_held",
    );
  });

  it("treats a reset whose reply was lost as blocking the near miss until a later input", () => {
    const edited = [staged("seed", 0), staged("after_edit", 1)];
    const log = {
      total: 3,
      lastApplied: { type: 1 },
      lastUnsettled: { reset: 2 },
    };
    expect(admitWitnessStage(edited, "near_miss", log)).toMatchObject({
      ok: false,
      error: expect.stringContaining("lost its reply"),
    });
    expect(
      admitWitnessStage(edited, "near_miss", {
        total: 4,
        lastApplied: { type: 3 },
        lastUnsettled: { reset: 2 },
      }),
    ).toEqual({ ok: true, value: 4 });
    const nearMiss = [...edited, staged("near_miss", 2)];
    expect(admitWitnessStage(nearMiss, "after_reset", log)).toMatchObject({
      ok: false,
      error: expect.stringContaining("reply was lost"),
    });
  });
});

describe("build witness edits", () => {
  it("never takes a reset as the edit or the near miss", () => {
    const seed = [staged("seed", 0)];
    // An edit made only of a reset, or undone by one, is no edit.
    expect(admit(seed, "after_edit", [action("reset")])).toMatchObject({
      ok: false,
      error: expect.stringContaining("act on the app"),
    });
    expect(
      admit(seed, "after_edit", [action("type"), action("reset")]),
    ).toMatchObject({ ok: false });
    const edited = [...seed, staged("after_edit", 1)];
    const log = [action("type")];
    // Reset after a passing edit, check near_miss on the seed: refused.
    expect(admit(edited, "near_miss", [...log, action("reset")])).toMatchObject(
      { ok: false, error: expect.stringContaining("reset") },
    );
    expect(
      admit(edited, "near_miss", [
        ...log,
        action("key"),
        action("reset"),
        action("screenshot"),
      ]),
    ).toMatchObject({ ok: false });
    // A near miss made after a reset is still a change of the app.
    expect(
      admit(edited, "near_miss", [...log, action("reset"), action("type")]),
    ).toEqual({ ok: true, value: 3 });
  });
});

describe("build witness over a long session", () => {
  it("reads the count and the last applied actions, so it holds after the log drops its oldest entries", () => {
    const seed = [staged("seed", 500)];
    expect(
      admitWitnessStage(seed, "after_edit", {
        total: 1000,
        lastApplied: { type: 999, reset: 10 },
      }),
    ).toEqual({ ok: true, value: 1000 });
    expect(
      admitWitnessStage(seed, "after_edit", {
        total: 1000,
        lastApplied: { type: 400 },
      }),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("act on the app"),
    });
    const nearMiss = [
      ...seed,
      staged("after_edit", 600),
      staged("near_miss", 800),
    ];
    expect(
      admitWitnessStage(nearMiss, "after_reset", {
        total: 1000,
        lastApplied: { key: 700, reset: 900 },
      }),
    ).toEqual({ ok: true, value: 1000 });
    expect(
      admitWitnessStage(nearMiss, "after_reset", {
        total: 1000,
        lastApplied: { key: 950, reset: 900 },
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("reset") });
  });
});

describe("build witness state views", () => {
  it("reads the app's data/get state into the views the checks read, keeping each file's error", () => {
    expect(
      appStateViews([
        { kind: "file", file: { bytes: "eA==" } },
        {
          kind: "data",
          data: {
            state: {
              "Documents/todo.txt": {
                format: "text",
                view: { lines: ["milk"], truncated: false },
                truncated: false,
              },
              "Documents/big.bin": {
                format: null,
                view: null,
                error: "larger than 64 MiB, the most the view reads",
              },
            },
          },
        },
      ]),
    ).toEqual({
      ok: true,
      value: new Map([
        [
          "Documents/todo.txt",
          {
            format: "text",
            view: { lines: ["milk"], truncated: false },
            error: null,
          },
        ],
        [
          "Documents/big.bin",
          {
            format: null,
            view: null,
            error: "larger than 64 MiB, the most the view reads",
          },
        ],
      ]),
    });
    expect(appStateViews([{ kind: "file" }])).toMatchObject({
      ok: false,
      error: expect.stringContaining("no state views"),
    });
  });
});
