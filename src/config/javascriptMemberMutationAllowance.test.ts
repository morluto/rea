import { expect, it } from "vitest";

import { AnalysisSettings } from "../application/AnalysisSettings.js";
import {
  DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
  MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
} from "../domain/analysisResourceLimits.js";
import { resolveJavaScriptMemberMutationAllowance } from "./javascriptMemberMutationAllowance.js";

const SEED = "REA_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES";

it("selects the runtime override, then the launch seed, then the default", () => {
  expect(resolveJavaScriptMemberMutationAllowance({})).toEqual({
    ok: true,
    value: {
      aliasStates: DEFAULT_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
      source: "default",
    },
  });
  expect(resolveJavaScriptMemberMutationAllowance({ [SEED]: "1024" })).toEqual({
    ok: true,
    value: { aliasStates: 1024, source: "setting" },
  });
  expect(
    resolveJavaScriptMemberMutationAllowance(
      { [SEED]: "not-a-number" },
      { "javascript.member_mutation_alias_states": 2048 },
    ),
  ).toEqual({ ok: true, value: { aliasStates: 2048, source: "runtime" } });
});

it("refuses a malformed or out-of-range launch seed instead of the default", () => {
  for (const value of [
    "0",
    "1.5",
    "-1",
    String(MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES + 1),
  ]) {
    const resolved = resolveJavaScriptMemberMutationAllowance({
      [SEED]: value,
    });
    expect(resolved.ok, value).toBe(false);
    if (!resolved.ok)
      expect(resolved.error.settings).toEqual([
        expect.objectContaining({ setting: SEED }),
      ]);
  }
});

it("accepts runtime updates only within the validated range", () => {
  const store = new AnalysisSettings({});
  for (const value of [0, MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES + 1])
    expect(
      store.update({
        changes: [
          {
            setting: "javascript.member_mutation_alias_states",
            action: "set",
            value,
          },
        ],
      }).ok,
    ).toBe(false);
  expect(
    store.update({
      changes: [
        {
          setting: "javascript.member_mutation_alias_states",
          action: "set",
          value: MAXIMUM_JAVASCRIPT_MEMBER_MUTATION_ALIAS_STATES,
        },
      ],
    }).ok,
  ).toBe(true);
});
