import { expect, it } from "vitest";
import {
  NUMERIC_LIMIT_DECLARATION,
  discoverNumericLimitUses,
  isNumericLimit,
  parseNumericLimitRegistry,
  parseRuntimeSettingEnvironments,
  perCallLimitFailures,
  requiredRuntimeLimitFailure,
} from "../../scripts/verify/rea-numeric-limits.mjs";

const ENDPOINT_CANDIDATES = "REA_WEB_BUNDLE_ENDPOINT_LITERAL_CANDIDATES";

it("reads only actual settings environment properties", () => {
  expect([
    ...parseRuntimeSettingEnvironments(`
    // environment: "REA_COMMENT_MAX_BYTES"
    const text = 'environment: "REA_STRING_MAX_BYTES"';
    export const ANALYSIS_SETTINGS = {
      first: { updateMode: "runtime", environment: "REA_REAL_MAX_BYTES" },
      parameter: { updateMode: "runtime", defaultValue: 1 },
    } as const;
  `),
  ]).toEqual(["REA_REAL_MAX_BYTES"]);
  expect(() =>
    parseRuntimeSettingEnvironments(
      'export const ANALYSIS_SETTINGS = { a: { environment: "REA_REAL_MAX_BYTES" } };',
    ),
  ).toThrow(/updateMode/);
  expect(() =>
    parseRuntimeSettingEnvironments(
      'export const ANALYSIS_SETTINGS = { a: { updateMode: "parameter" } };',
    ),
  ).toThrow(/updateMode/);
  expect(() =>
    parseRuntimeSettingEnvironments(
      "export const ANALYSIS_SETTINGS = { a: { environment: value } };",
    ),
  ).toThrow();
  expect(() =>
    parseRuntimeSettingEnvironments(
      'export const ANALYSIS_SETTINGS = { a: { environment: "REA_OLD_MAX_BYTES", ...other } };',
    ),
  ).toThrow();
  expect(() =>
    parseRuntimeSettingEnvironments(
      'export const ANALYSIS_SETTINGS = { a: { environment: "REA_OLD_MAX_BYTES", [key]: "REA_NEW_MAX_BYTES" } };',
    ),
  ).toThrow();
  expect(() =>
    parseRuntimeSettingEnvironments(`
    const shared = { type: "number" };
    Object.assign(shared, { environment: "REA_NEW_MAX_BYTES" });
    export const ANALYSIS_SETTINGS = { a: { environment: "REA_OLD_MAX_BYTES", ...shared } };
  `),
  ).toThrow();
});

it("parses declared external provenance rather than inferring it from prose", () => {
  const source = `export const NUMERIC_LIMIT_REGISTRY = [{
    read: "startup", name: "REA_HOPPER_TIMEOUT_MS", reason: "external reader",
    update_mode: "restart", policy: "restart-only",
    provenance: { kind: "external-reader", source: "scripts/helper.py", witness: "tests/helper.test.ts" },
  }] as const;`;
  expect(parseNumericLimitRegistry(source)).toEqual([
    {
      name: "REA_HOPPER_TIMEOUT_MS",
      update_mode: "restart",
      policy: "restart-only",
      read: "startup",
      reason: "external reader",
      provenance: {
        kind: "external-reader",
        source: "scripts/helper.py",
        witness: "tests/helper.test.ts",
      },
    },
  ]);
  expect(() =>
    parseNumericLimitRegistry(source.replace('update_mode: "restart", ', "")),
  ).toThrow(/update_mode/);
  expect(() =>
    parseNumericLimitRegistry(
      source.replace('update_mode: "restart"', 'update_mode: "runtime"'),
    ),
  ).toThrow(/Invalid numeric limit registry entry/);
  expect(() =>
    parseNumericLimitRegistry(
      source.replace('source: "scripts/helper.py"', "source: dynamicPath"),
    ),
  ).toThrow(/source must be a string literal/);
  expect(() =>
    parseNumericLimitRegistry(
      source.replace('kind: "external-reader"', 'kind: "generated-control"'),
    ),
  ).toThrow(/Invalid external provenance/);
});

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

it("distinguishes direct environment reads from unrelated candidate syntax", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/candidates.ts",
      source: `
        console.log("REA_LOG_MAX_BYTES");
        new Error("REA_ERROR_MAX_BYTES");
        const object = { REA_OBJECT_MAX_BYTES: 1 };
        const present = "REA_IN_MAX_BYTES" in {};
        function shadow(process) { return process.env.REA_SHADOW_MAX_BYTES; }
        const direct = process.env.REA_DIRECT_MAX_BYTES;
      `,
    },
  ]);
  for (const name of [
    "REA_LOG_MAX_BYTES",
    "REA_ERROR_MAX_BYTES",
    "REA_OBJECT_MAX_BYTES",
    "REA_IN_MAX_BYTES",
    "REA_SHADOW_MAX_BYTES",
  ])
    expect(
      discovered
        .get(name)
        ?.sites.every((site) => site.evidence === "candidate"),
      name,
    ).toBe(true);
  expect(
    discovered
      .get("REA_DIRECT_MAX_BYTES")
      ?.sites.some((site) => site.evidence === "direct"),
  ).toBe(true);
});

it("keeps mutable and shadowed aliases from proving a setting read", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/aliases.ts",
      source: `
    const key = "REA_OUTER_MAX_BYTES";
    function shadow(key) { return Number(process.env[key]); }
    let mutable = "REA_MUTABLE_MAX_BYTES";
    mutable = "OTHER";
    Number(process.env[mutable]);
    const config = { name: "REA_OBJECT_ALIAS_MAX_BYTES" };
    config.name = "OTHER";
    Number(process.env[config.name]);
    const stable = "REA_STABLE_MAX_BYTES";
    Number(process.env[stable]);
        const choice = flag ? "REA_CHOICE_MAX_BYTES" : "REA_OTHER_MAX_BYTES";
        process.env[choice];
  `,
    },
  ]);
  expect(discovered.has("REA_OUTER_MAX_BYTES")).toBe(false);
  for (const name of [
    "REA_MUTABLE_MAX_BYTES",
    "REA_OBJECT_ALIAS_MAX_BYTES",
    "REA_CHOICE_MAX_BYTES",
    "REA_OTHER_MAX_BYTES",
  ])
    expect(
      discovered
        .get(name)
        ?.sites.every((site) => site.evidence === "candidate"),
      name,
    ).toBe(true);
  expect(
    discovered
      .get("REA_STABLE_MAX_BYTES")
      ?.sites.some((site) => site.evidence === "direct"),
  ).toBe(true);
  expect(discovered.unresolved.map((issue) => issue.reason)).toEqual(
    expect.arrayContaining([
      "mutable setting-key or value alias",
      "object setting-key property may have changed",
      "dynamic environment key is not statically known",
    ]),
  );
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
  expect(discovered.get(name)).toMatchObject({
    path: "src/config/constructedLimit.ts",
    read: "construction",
  });
});

it("keeps deferred read timing unknown instead of assuming per-call", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/callbacks.ts",
      source: `class Session {
        limit = process.env.REA_FIELD_MAX_BYTES;
        constructor(environment) {
          this.read = () => environment.REA_DEFERRED_MAX_BYTES;
          this.snapshot = (() => environment.REA_SNAPSHOT_MAX_BYTES)();
        }
      }`,
    },
  ]);
  expect(discovered.get("REA_DEFERRED_MAX_BYTES")?.read).toBe("unknown");
  expect(discovered.get("REA_SNAPSHOT_MAX_BYTES")?.read).toBe("construction");
  expect(discovered.get("REA_FIELD_MAX_BYTES")?.read).toBe("construction");
});

it("retains distinct syntactic sites without claiming complete lifetime coverage", () => {
  const name = "REA_MIXED_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/start.ts",
      source: `const value = process.env.${name};`,
    },
    {
      path: "src/config/later.ts",
      source: `function read() { return process.env.${name}; }`,
    },
  ]);
  expect(discovered.get(name)).toMatchObject({
    read: "unknown",
    sites: [
      { path: "src/config/start.ts", read: "module" },
      { path: "src/config/later.ts", read: "unknown" },
    ],
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
  expect(discovered.get(name)).toMatchObject({
    path: "src/config/archiveLimit.ts",
    read: "module",
  });
  expect(
    discoverNumericLimitUses([
      {
        path: "src/config/indexedArchiveLimit.ts",
        source: `const indexed = Number(environment["${name}"]);`,
      },
    ]).get(name),
  ).toMatchObject({
    path: "src/config/indexedArchiveLimit.ts",
    read: "module",
  });
  expect(
    discoverNumericLimitUses([
      {
        path: "src/config/schemaArchiveLimit.ts",
        source: `const indexed = z.number().int().parse(process.env.${name});`,
      },
    ]).get(name),
  ).toMatchObject({ path: "src/config/schemaArchiveLimit.ts", read: "module" });
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

it("distinguishes numeric values from unrelated reads in numeric expressions", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/limits.ts",
      source: `
        const flag = Number(process.env.REA_ANALYSIS_PROVIDER === "ghidra");
        const conditional = Number(process.env.REA_ANALYSIS_PROVIDER ? 1 : 2);
        const truthy = Number(process.env.REA_ANALYSIS_PROVIDER && 42);
        const indirect = Number(getValue(process.env.REA_ANALYSIS_PROVIDER));
        function shadow(Number) { return Number.parseInt(process.env.REA_SHADOWED_ENTRY_LIMIT); }
        function shadowParser(parseInt, parseFloat) {
          return parseInt(process.env.REA_SHADOWED_ONE) + parseFloat(process.env.REA_SHADOWED_TWO);
        }
        const direct = Number(process.env.REA_ARCHIVE_ENTRY_LIMIT ?? "8");
        const unary = +process.env.REA_FIRST_ENTRY_LIMIT;
        const parsed = Number.parseInt(process.env.REA_SECOND_ENTRY_LIMIT, 10);
        const adjusted = Number(process.env.REA_THIRD_ENTRY_LIMIT - 1);
        const scaled = parseInt(process.env.REA_FOURTH_ENTRY_LIMIT * 2);
        const templated = Number(\`\${process.env.REA_FIFTH_ENTRY_LIMIT}\`);
      `,
    },
  ]);
  expect(discovered.has("REA_ANALYSIS_PROVIDER")).toBe(false);
  expect(discovered.has("REA_SHADOWED_ENTRY_LIMIT")).toBe(false);
  expect(discovered.has("REA_SHADOWED_ONE")).toBe(false);
  expect(discovered.has("REA_SHADOWED_TWO")).toBe(false);
  expect(discovered.has("REA_ARCHIVE_ENTRY_LIMIT")).toBe(true);
  expect(discovered.has("REA_FIRST_ENTRY_LIMIT")).toBe(true);
  expect(discovered.has("REA_SECOND_ENTRY_LIMIT")).toBe(true);
  expect(discovered.has("REA_THIRD_ENTRY_LIMIT")).toBe(true);
  expect(discovered.has("REA_FOURTH_ENTRY_LIMIT")).toBe(true);
  expect(discovered.has("REA_FIFTH_ENTRY_LIMIT")).toBe(true);
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
    {
      path: "src/config/remediation.ts",
      source: `const help = \`${name} = 100 is the documented default\`;`,
    },
    {
      path: "src/config/constant.ts",
      source: `export const unused = "${name}";`,
    },
  ]);
  expect(prose.has(name)).toBe(false);
  const assigned = discoverNumericLimitUses([
    {
      path: "src/hopper/BridgeLauncher.ts",
      source: `const line = \`${name} = \${timeout / 1_000}\`;`,
    },
  ]);
  expect(assigned.has(name)).toBe(false);
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

it("distinguishes a write-only environment property from a read-modify-write", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/write.ts",
      source: `
        environment.REA_REMOVED_MAX_BYTES = 10;
        delete environment["REA_DELETED_MAX_BYTES"];
        environment.REA_COUNT_MAX_BYTES += 1;
      `,
    },
  ]);
  expect(discovered.has("REA_REMOVED_MAX_BYTES")).toBe(false);
  expect(discovered.has("REA_DELETED_MAX_BYTES")).toBe(false);
  expect(discovered.has("REA_COUNT_MAX_BYTES")).toBe(true);
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
