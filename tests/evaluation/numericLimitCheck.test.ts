import { expect, it } from "vitest";
import {
  NUMERIC_LIMIT_DECLARATION,
  discoverNumericLimitUses,
  isNumericLimit,
  requiredRuntimeLimitFailure,
} from "../../scripts/verify/rea-numeric-limits.mjs";

const ENDPOINT_CANDIDATES = "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES";

it("recognizes the documented endpoint-candidate limit as numeric", () => {
  expect(isNumericLimit(ENDPOINT_CANDIDATES)).toBe(true);
  const discovered = discoverNumericLimitUses([
    {
      path: "src/domain/webBundleAnalysis.ts",
      source: `const candidates = process.env.${ENDPOINT_CANDIDATES};`,
    },
  ]);
  expect(discovered.get(ENDPOINT_CANDIDATES)).toBe(
    "src/domain/webBundleAnalysis.ts",
  );
});

it("does not treat a registry declaration as a producer", () => {
  const name = "REA_REMOVED_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: NUMERIC_LIMIT_DECLARATION,
      source: `name: "${name}",`,
    },
    {
      path: "src/config/removedLimit.ts",
      source: `const value = process.env.${name};`,
    },
  ]);
  expect(discovered.get(name)).toBe("src/config/removedLimit.ts");
  expect(
    discoverNumericLimitUses([
      { path: NUMERIC_LIMIT_DECLARATION, source: `name: "${name}",` },
    ]).has(name),
  ).toBe(false);
});

it("keeps a bracket-access read as a producer", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source: `const selected = environment["${name}"] ?? environment?.[ "${name}" ];`,
    },
  ]);
  expect(discovered.get(name)).toBe("src/config/newLimit.ts");
});

it("does not treat a registration allowlist or a comment as a producer", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: NUMERIC_LIMIT_DECLARATION,
      source: `name: "${ENDPOINT_CANDIDATES}",`,
    },
    {
      path: "src/application/SetupRegistrationEnvironment.ts",
      source: `const SELECTED_REGISTRATION_SETTINGS = ["${ENDPOINT_CANDIDATES}"] as const;`,
    },
    {
      path: "src/config/removedLimit.ts",
      source: `// ${ENDPOINT_CANDIDATES} used to be read here\nconst unrelated = 1;\n`,
    },
  ]);
  expect(discovered.has(ENDPOINT_CANDIDATES)).toBe(false);
});

it("requires the tracked endpoint-candidate limit to be an analysis setting", () => {
  expect(
    requiredRuntimeLimitFailure(ENDPOINT_CANDIDATES, {
      inRuntime: false,
      inRegistry: true,
    }),
  ).toMatch(/ANALYSIS_SETTINGS/);
  expect(
    requiredRuntimeLimitFailure(ENDPOINT_CANDIDATES, {
      inRuntime: true,
      inRegistry: false,
    }),
  ).toBeUndefined();
  expect(
    requiredRuntimeLimitFailure("REA_NTFS_MFT_MAX_FILE_BYTES", {
      inRuntime: false,
      inRegistry: false,
    }),
  ).toMatch(/ANALYSIS_SETTINGS/);
  expect(
    requiredRuntimeLimitFailure("REA_REGF_HIVE_MAX_FILE_BYTES", {
      inRuntime: true,
      inRegistry: true,
    }),
  ).toMatch(/numericLimitRegistry/);
});
