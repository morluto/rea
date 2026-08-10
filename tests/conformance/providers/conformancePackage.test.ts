import { describe, expect, it } from "vitest";

import {
  CONFORMANCE_PACKAGE_VERSION,
  createConformancePackage,
  parseConformancePackage,
  type ConformancePackageInput,
} from "../../../src/domain/conformancePackage.js";

const validPackageInput: ConformancePackageInput = {
  schema_version: CONFORMANCE_PACKAGE_VERSION,
  name: "test-fixture",
  description: "A test conformance fixture",
  created_at: "2026-07-28T00:00:00Z",
  scenarios: [
    {
      scenario_id: "s1",
      name: "Simple spawn",
      description: "A simple process spawn scenario",
      fixture_path: "tests/conformance/c/fixture.c",
      expected_exit_code: 0,
      expected_patterns: ["Hello", "World"],
    },
  ],
  replay_plans: [
    {
      scenario_id: "s1",
      steps: [
        {
          step_id: "step1",
          action: "compile",
          arguments: ["gcc", "fixture.c"],
          timeout_ms: 5000,
        },
      ],
      environment: {},
    },
  ],
  shim_plans: [],
  expected_evidence: [
    {
      scenario_id: "s1",
      envelopes: [],
      bundle: null,
      required_dimensions: ["exit_code", "stdout"],
    },
  ],
  verifier_contracts: [
    {
      scenario_id: "s1",
      dimensions: [
        {
          name: "exit_code",
          required: true,
          comparison: "exact",
        },
      ],
      timing_tolerance_ms: 100,
    },
  ],
};

const validPackage = createConformancePackage(validPackageInput);

describe("conformance package parsing", () => {
  it("parses a well-formed content-addressed package", () => {
    expect(parseConformancePackage(validPackage)).toEqual({
      ok: true,
      value: validPackage,
    });
  });

  it("rejects invalid package structure", () => {
    expect(
      parseConformancePackage({ ...validPackage, schema_version: 999 }),
    ).toMatchObject({ ok: false, error: { kind: "invalid_package" } });
  });

  it("rejects duplicate scenario IDs", () => {
    expect(
      parseConformancePackage({
        ...validPackage,
        scenarios: [validPackage.scenarios[0], validPackage.scenarios[0]],
      }),
    ).toMatchObject({
      ok: false,
      error: { kind: "duplicate_scenario", scenario_id: "s1" },
    });
  });

  it.each([
    ["replay_plans", "replay_plans"],
    ["shim_plans", "shim_plans"],
    ["expected_evidence", "expected_evidence"],
    ["verifier_contracts", "verifier_contracts"],
  ] as const)("rejects an unknown scenario in %s", (field, section) => {
    const existing = validPackage[field][0];
    const candidate = existing ?? {
      scenario_id: "nonexistent",
      shims: [],
    };
    expect(
      parseConformancePackage({
        ...validPackage,
        [field]: [{ ...candidate, scenario_id: "nonexistent" }],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "unknown_scenario_reference",
        section,
        scenario_id: "nonexistent",
      },
    });
  });

  it("requires one replay plan for every scenario", () => {
    expect(
      parseConformancePackage({
        ...validPackage,
        scenarios: [
          ...validPackage.scenarios,
          {
            scenario_id: "s2",
            name: "Second scenario",
            description: "A second process scenario",
            fixture_path: "tests/conformance/c/fixture2.c",
            expected_exit_code: 0,
            expected_patterns: [],
          },
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "missing_scenario_reference",
        section: "replay_plans",
        scenario_id: "s2",
      },
    });
  });

  it("rejects duplicate per-scenario records", () => {
    expect(
      parseConformancePackage({
        ...validPackage,
        verifier_contracts: [
          validPackage.verifier_contracts[0],
          validPackage.verifier_contracts[0],
        ],
      }),
    ).toMatchObject({
      ok: false,
      error: {
        kind: "duplicate_scenario_reference",
        section: "verifier_contracts",
        scenario_id: "s1",
      },
    });
  });

  it("rejects a stale package identifier", () => {
    expect(
      parseConformancePackage({ ...validPackage, name: "modified" }),
    ).toMatchObject({
      ok: false,
      error: { kind: "package_id_mismatch" },
    });
  });
});

describe("conformance package construction", () => {
  it("derives a deterministic identifier from parsed contents", () => {
    const same = createConformancePackage(validPackageInput);
    const changed = createConformancePackage({
      ...validPackageInput,
      name: "another-package",
    });

    expect(same.package_id).toBe(validPackage.package_id);
    expect(changed.package_id).not.toBe(validPackage.package_id);
  });

  it("applies schema defaults before committing the identifier", () => {
    const { shim_plans: _shimPlans, ...withoutOptionalShimPlans } =
      validPackageInput;
    const created = createConformancePackage(withoutOptionalShimPlans);

    expect(created.shim_plans).toEqual([]);
    expect(parseConformancePackage(created)).toEqual({
      ok: true,
      value: created,
    });
  });

  it("cannot construct a package with contradictory scenario relations", () => {
    expect(() =>
      createConformancePackage({
        ...validPackageInput,
        scenarios: [...validPackage.scenarios, ...validPackage.scenarios],
      }),
    ).toThrow(/Duplicate scenario s1/u);
  });
});
