import { expect, it } from "vitest";
import {
  NUMERIC_LIMIT_DECLARATION,
  discoverNumericLimitUses,
  isNumericLimit,
  perCallLimitFailures,
  requiredRuntimeLimitFailure,
} from "../../scripts/verify/rea-numeric-limits.mjs";

const ENDPOINT_CANDIDATES = "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES";

it("requires the temporary per-call allowlist to match the registry", () => {
  const temporary = new Set(["REA_OLD_TIMEOUT_MS"]);
  expect(
    perCallLimitFailures(
      new Map([["REA_OLD_TIMEOUT_MS", "per-call"]]),
      temporary,
    ),
  ).toEqual([]);
  expect(perCallLimitFailures(new Map(), temporary)).toEqual([
    expect.stringContaining(
      "REA_OLD_TIMEOUT_MS is no longer a temporary per-call exception",
    ),
  ]);
  expect(
    perCallLimitFailures(
      new Map([["REA_OLD_TIMEOUT_MS", "restart-only"]]),
      temporary,
    ),
  ).toHaveLength(1);
  expect(
    perCallLimitFailures(
      new Map([["REA_NEW_TIMEOUT_MS", "per-call"]]),
      new Set(),
    ),
  ).toEqual([
    expect.stringContaining("REA_NEW_TIMEOUT_MS is a new per-call exception"),
  ]);
});

it("recognizes the documented endpoint-candidate limit as numeric", () => {
  expect(isNumericLimit(ENDPOINT_CANDIDATES)).toBe(true);
  const discovered = discoverNumericLimitUses([
    {
      path: "src/domain/webBundleAnalysis.ts",
      source: `const candidates = process.env.${ENDPOINT_CANDIDATES};`,
    },
  ]);
  expect(discovered.get(ENDPOINT_CANDIDATES)?.path).toBe(
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
  expect(discovered.get(name)?.path).toBe("src/config/removedLimit.ts");
  expect(
    discoverNumericLimitUses([
      { path: NUMERIC_LIMIT_DECLARATION, source: `name: "${name}",` },
    ]).has(name),
  ).toBe(false);
});

it("keeps a helper-call argument that is not the first argument", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source: `const setting = "${name}";\nconst value = read(environment, setting);`,
    },
    {
      path: "src/config/literalLimit.ts",
      source: `const value = read(environment, "${name}");`,
    },
  ]);
  expect(discovered.get(name)?.path).toBe("src/config/newLimit.ts");
});

it("does not treat prose that mentions a limit name as a producer", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/domain/native/nativeDeadlines.ts",
      source: `const guidance = "input_bytes overrides ${name}; otherwise that launch default applies.";`,
    },
  ]);
  expect(discovered.has(name)).toBe(false);
});

it("keeps a destructured environment key, including a rename and a default", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source: `const { ${name}: renamed = 1 } = process.env;\nconst present = "${name}" in environment;\nconst owned = Object.hasOwn(environment, "${name}");\nconst source = { ${name}: renamed };\nconst copy = { ...source };`,
    },
  ]);
  expect(discovered.get(name)?.path).toBe("src/config/newLimit.ts");
});

it("records a constructor read separately from a per-call read", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/constructedLimit.ts",
      source: `class Session {\n  constructor(environment) {\n    this.limit = environment.${name};\n  }\n}`,
    },
  ]);
  expect(discovered.get(name)).toEqual({
    path: "src/config/constructedLimit.ts",
    read: "construction",
  });
});

it("treats a count parsed from a property access as numeric without a suffix", () => {
  const name = "REA_ARCHIVE_ENTRY_LIMIT";
  expect(isNumericLimit(name)).toBe(false);
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/archiveLimit.ts",
      source: `const limit = Number(process.env.${name});\nconst indexed = parseInt(environment["${name}"], 10);`,
    },
  ]);
  expect(discovered.get(name)).toEqual({
    path: "src/config/archiveLimit.ts",
    read: "call",
  });
  expect(
    discoverNumericLimitUses([
      {
        path: "src/config/indexedArchiveLimit.ts",
        source: `const indexed = Number(environment["${name}"]);`,
      },
    ]).get(name),
  ).toEqual({ path: "src/config/indexedArchiveLimit.ts", read: "call" });
  expect(
    discoverNumericLimitUses([
      {
        path: "src/config/schemaArchiveLimit.ts",
        source: `const indexed = z.number().int().parse(process.env.${name});`,
      },
    ]).get(name),
  ).toEqual({ path: "src/config/schemaArchiveLimit.ts", read: "call" });
  expect(
    discoverNumericLimitUses([
      {
        path: "src/application/SetupHost.ts",
        source:
          "const requested = analysisProviderSelectorSchema.safeParse(environment.REA_ANALYSIS_PROVIDER);",
      },
    ]).has("REA_ANALYSIS_PROVIDER"),
  ).toBe(false);
});

it("does not let diagnostic template prose stand in for a removed producer", () => {
  const name = "REA_NEW_MAX_BYTES";
  const prose = discoverNumericLimitUses([
    {
      path: "src/config/mcpResponseBudget.ts",
      source: `const guidance = \`The effective ${name} value is \${String(effective)} bytes. A change requires restarting.\`;`,
    },
    {
      path: "src/gdb/GdbSessionManager.ts",
      source: `return \`This release has no runtime override; ${name} does not raise it.\`;`,
    },
    {
      path: "src/config/comparedLimit.ts",
      source: `const same = \`${name} === \${limit}\`;`,
    },
  ]);
  expect(prose.has(name)).toBe(false);
  const assigned = discoverNumericLimitUses([
    {
      path: "src/hopper/BridgeLauncher.ts",
      source: `const line = \`${name} = \${timeout / 1_000}\`;`,
    },
  ]);
  expect(assigned.get(name)).toEqual({
    path: "src/hopper/BridgeLauncher.ts",
    read: "call",
  });
});

it("does not invent a limit from a spread of the environment object", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source: "const copy = { ...process.env, ...environment };",
    },
  ]);
  expect(discovered.size).toBe(0);
});

it("keeps a bracket-access read as a producer", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source: `const selected = environment["${name}"] ?? environment?.[ "${name}" ];`,
    },
  ]);
  expect(discovered.get(name)?.path).toBe("src/config/newLimit.ts");
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
