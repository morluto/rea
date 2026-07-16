import { describe, expect, it } from "vitest";

import {
  createRuntimeCharacterizationPlan,
  parseRuntimeCharacterizationPlan,
} from "../src/domain/runtimeCharacterization.js";

const digest = (character: string): string => character.repeat(64);

describe("provider-neutral runtime characterization plan", () => {
  it("commits preparation separately from execution approval", () => {
    const plan = createRuntimeCharacterizationPlan({
      schema_version: 1,
      preparation_sha256: digest("5"),
      artifact: {
        path: "/approved/app.js",
        sha256: digest("1"),
        byte_length: 100,
      },
      runtime: {
        family: "ecmascript",
        provider_id: "node-javascript",
        executable_path: "/usr/bin/node",
        executable_sha256: digest("2"),
        version: "v24.18.0",
        profile_sha256: digest("3"),
      },
      callable: {
        callable_id: "bundle.module7.hidden",
        module_id: "bundle.module7",
        export_name: "selected",
        semantic_evidence_id: null,
        selector_sha256: digest("4"),
      },
      working_directory: "/owned/work",
      isolated_home: "/owned/home",
      expected_effect: "pure",
      allowed_boundaries: [],
      limits: {
        max_calls: 2,
        max_processes: 0,
        max_files: 0,
        max_bytes: 65_536,
        max_handles: 32,
        timeout_ms: 5_000,
        idle_timeout_ms: 1_000,
      },
      determinism: {
        clock: "fixed",
        randomness: "seeded",
        identifiers: "deterministic",
        seed: 7,
      },
      authority: {
        preparation_approved: true,
        execution_approved: false,
        network: "none",
        provider_owned_process_only: true,
      },
    });

    expect(parseRuntimeCharacterizationPlan(plan)).toEqual(plan);
    expect(plan.authority.execution_approved).toBe(false);
    expect(() =>
      parseRuntimeCharacterizationPlan({
        ...plan,
        expected_effect: "bounded-effects",
      }),
    ).toThrow(/digest is invalid/u);
  });
});
