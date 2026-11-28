import { expect, it } from "vitest";
import {
  compareDocumentedNumericLimits,
  discoverNumericLimitUses,
  documentedLimitCell,
  parseDocumentedNumericLimits,
  parseNumericLimitRegistry,
  parseRuntimeSettingEnvironments,
  requiredRuntimeLimitFailure,
} from "../../scripts/verify/rea-numeric-limits.mjs";

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
      'export const ANALYSIS_SETTINGS = { a: { updateMode: "runtime", environment: value } };',
    ),
  ).toThrow(/environment must be a static REA_/u);
  expect(() =>
    parseRuntimeSettingEnvironments(
      'export const ANALYSIS_SETTINGS = { a: { updateMode: "runtime", environment: "REA_OLD_MAX_BYTES", ...other } };',
    ),
  ).toThrow(/fields must be static named assignments/u);
  expect(() =>
    parseRuntimeSettingEnvironments(
      'export const ANALYSIS_SETTINGS = { a: { updateMode: "runtime", environment: "REA_OLD_MAX_BYTES", [key]: "REA_NEW_MAX_BYTES" } };',
    ),
  ).toThrow(/fields must be static named assignments/u);
  expect(() =>
    parseRuntimeSettingEnvironments(`
    const shared = { type: "number" };
    Object.assign(shared, { environment: "REA_NEW_MAX_BYTES" });
    export const ANALYSIS_SETTINGS = { a: { updateMode: "runtime", environment: "REA_OLD_MAX_BYTES", ...shared } };
  `),
  ).toThrow(/fields must be static named assignments/u);
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

it("directs per-call registry declarations to ANALYSIS_SETTINGS", () => {
  expect(() =>
    parseNumericLimitRegistry(`
      export const NUMERIC_LIMIT_REGISTRY = [{
        name: "REA_NEW_TIMEOUT_MS", update_mode: "restart", policy: "per-call",
        read: "per-call", reason: "A deadline selected during each call",
      }];
    `),
  ).toThrow(/REA_NEW_TIMEOUT_MS.*ANALYSIS_SETTINGS/u);
});

it("does not treat a registry declaration as a producer", () => {
  const name = "REA_REMOVED_MAX_BYTES";
  const source = `const value = process.env.${name};`;
  const discovered = discoverNumericLimitUses([
    {
      path: "src/domain/numericLimitRegistry.ts",
      source,
    },
    {
      path: "src/config/removedLimit.ts",
      source,
    },
  ]);
  expect(discovered.get(name)?.sites).toMatchObject([
    { path: "src/config/removedLimit.ts", evidence: "direct" },
  ]);
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
  expect(discovered.get(name)?.sites).toMatchObject([
    { path: "src/config/newLimit.ts", evidence: "candidate" },
    { path: "src/config/literalLimit.ts", evidence: "candidate" },
  ]);
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

it("reports each mutable alias once while keeping dynamic reads unresolved", () => {
  const source = `
    let key = "REA_SAMPLE_MAX_BYTES";
    consume(key);
    consume(key);
    Number(process.env[key]);
    let other = "REA_OTHER_MAX_BYTES";
    consume(other);
  `;
  const discovered = discoverNumericLimitUses([
    { path: "src/aliases.ts", source },
  ]);
  expect(
    discovered.unresolved.filter(
      (issue) => issue.reason === "mutable setting-key or value alias",
    ),
  ).toEqual([
    expect.objectContaining({
      offset: source.indexOf("key ="),
      line: 2,
      column: 9,
    }),
    expect.objectContaining({
      offset: source.indexOf("other ="),
      line: 6,
      column: 9,
    }),
  ]);
  expect(discovered.unresolved).toContainEqual(
    expect.objectContaining({
      reason: "dynamic environment key is not statically known",
    }),
  );
});

it("retains uncertainty for mutable suffixless settings passed to other functions", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/aliases.ts",
      source: `
        let size = process.env.REA_SIZE;
        consume(size);
      `,
    },
  ]);
  const mutable = discovered.unresolved.filter(
    (issue) => issue.reason === "mutable setting-key or value alias",
  );
  expect(mutable.map((issue) => issue.line)).toEqual([2]);
});

it("does not attribute an unrelated same-named local to a numeric limit", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/shadowed-paths.ts",
      source: `
        const selectedPath = process.env.REA_SAMPLE_MAX_BYTES;
        Number(selectedPath);
        function inspect(path: string) {
          let selectedPath = path;
          consume(selectedPath);
        }
      `,
    },
  ]);
  expect(discovered.get("REA_SAMPLE_MAX_BYTES")?.sites).toEqual(
    expect.arrayContaining([expect.objectContaining({ evidence: "direct" })]),
  );
  expect(discovered.unresolved).toEqual([]);
});

it("keeps a destructured environment key, including a rename and a default", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source: `const { ${name}: renamed = 1 } = process.env;`,
    },
  ]);
  expect(discovered.get(name)?.path).toBe("src/config/newLimit.ts");
});

it("classifies a direct constructor read as construction", () => {
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
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/archiveLimit.ts",
      source: `const limit = Number(process.env.${name}); const unparsed = process.env.REA_ARCHIVE_LABEL;`,
    },
  ]);
  expect(discovered.get(name)).toMatchObject({
    path: "src/config/archiveLimit.ts",
    read: "module",
  });
  expect(discovered.has("REA_ARCHIVE_LABEL")).toBe(false);
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

it("does not count mentions or generated text as limit readers", () => {
  const name = "REA_NEW_MAX_BYTES";
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/guidance.ts",
      source: `// ${name} used to be read here
        const guidance = "input_bytes overrides ${name}";
        const template = \`The effective ${name} value is \${String(effective)} bytes\`;
        export const unused = "${name}";`,
    },
    {
      path: "src/application/SetupRegistrationEnvironment.ts",
      source: `const SELECTED_REGISTRATION_SETTINGS = ["${name}"] as const;`,
    },
    {
      path: "src/hopper/BridgeLauncher.ts",
      source: `const line = \`${name} = \${timeout / 1_000}\`;`,
    },
  ]);
  expect(discovered.has(name)).toBe(false);
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

it("keeps ordinary and optional bracket-access reads", () => {
  const discovered = discoverNumericLimitUses([
    {
      path: "src/config/newLimit.ts",
      source:
        'const selected = process.env["REA_PRIMARY_MAX_BYTES"] ?? process.env?.["REA_FALLBACK_MAX_BYTES"];',
    },
  ]);
  for (const name of ["REA_PRIMARY_MAX_BYTES", "REA_FALLBACK_MAX_BYTES"])
    expect(discovered.get(name)?.sites, name).toMatchObject([
      { path: "src/config/newLimit.ts", evidence: "direct" },
    ]);
});

it("reports a required limit absent from src as a typed missing result", () => {
  const name = "REA_ABSENT_MAX_BYTES";
  expect(
    requiredRuntimeLimitFailure(name, {
      inSource: false,
      inRuntime: false,
      inRegistry: false,
    }),
  ).toEqual({ code: "required_runtime_limit_missing", name });
  expect(
    requiredRuntimeLimitFailure(name, {
      inSource: true,
      inRuntime: false,
      inRegistry: true,
    }),
  ).toEqual({ code: "required_runtime_limit_not_analysis_setting", name });
  expect(
    requiredRuntimeLimitFailure(name, {
      inSource: true,
      inRuntime: false,
      inRegistry: false,
    }),
  ).toEqual({ code: "required_runtime_limit_not_analysis_setting", name });
  expect(
    requiredRuntimeLimitFailure(name, {
      inSource: false,
      inRuntime: true,
      inRegistry: true,
    }),
  ).toEqual({ code: "required_runtime_limit_not_analysis_setting", name });
  expect(
    requiredRuntimeLimitFailure(name, {
      inSource: false,
      inRuntime: true,
      inRegistry: false,
    }),
  ).toBeUndefined();
  expect(
    requiredRuntimeLimitFailure(name, {
      inSource: true,
      inRuntime: true,
      inRegistry: false,
    }),
  ).toBeUndefined();
});

const documentedLimits = `
## Runtime analysis settings

| Setting | Default | Floor | Maximum |
| --- | --- | --- | --- |
| \`sample.bytes\` | 10 | 1 | 20 |

## Per-call limits in the runtime system

| Environment | Default | Floor | Maximum |
| --- | --- | --- | --- |
| \`REA_SAMPLE_BYTES\` | unset (\`null\`, none) | 1 | \`Number.MAX_SAFE_INTEGER\` |

## Restart-only numeric limits

| Environment | Default | Floor | Maximum |
| --- | --- | --- | --- |
| \`REA_FIXED\` | 30 | 30 | 30 |
`;

it("rejects a fractional documented cell instead of keeping its leading digits", () => {
  expect(documentedLimitCell("5000.5", {}).ok).toBe(false);
  expect(documentedLimitCell("5000.", {}).ok).toBe(false);
  expect(documentedLimitCell("60000 (MCP SDK default)", {})).toEqual({
    ok: true,
    value: 60_000,
  });
  expect(documentedLimitCell("10485760 when unset", {})).toEqual({
    ok: true,
    value: 10_485_760,
  });
  const rows = parseDocumentedNumericLimits(
    documentedLimits.replace(
      "| `sample.bytes` | 10 |",
      "| `sample.bytes` | 5000.5 |",
    ),
  );
  const failures = compareDocumentedNumericLimits(
    rows,
    [
      { name: "sample.bytes", defaultValue: 5000, minimum: 1, maximum: 20 },
      {
        name: "sample.launch",
        aliases: ["REA_SAMPLE_BYTES"],
        defaultValue: null,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      { name: "REA_FIXED", defaultValue: 30, minimum: 30, maximum: 30 },
    ],
    { "Number.MAX_SAFE_INTEGER": Number.MAX_SAFE_INTEGER },
  );
  expect(failures).toEqual([
    'sample.bytes default: documented "5000.5" (unreadable cell "5000.5"), code 5000',
  ]);
});

it("names the limit and both values when a documented default drifts", () => {
  const failures = compareDocumentedNumericLimits(
    parseDocumentedNumericLimits(documentedLimits),
    [
      { name: "sample.bytes", defaultValue: 11, minimum: 1, maximum: 20 },
      {
        name: "sample.launch",
        aliases: ["REA_SAMPLE_BYTES"],
        defaultValue: null,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
      { name: "REA_FIXED", defaultValue: 30, minimum: 30, maximum: 30 },
    ],
    { "Number.MAX_SAFE_INTEGER": Number.MAX_SAFE_INTEGER },
  );
  expect(failures).toEqual(["sample.bytes default: documented 10, code 11"]);
});

it("names a documented limit the code does not export", () => {
  const failures = compareDocumentedNumericLimits(
    parseDocumentedNumericLimits(documentedLimits),
    [
      { name: "sample.bytes", defaultValue: 10, minimum: 1, maximum: 20 },
      {
        name: "sample.launch",
        aliases: ["REA_SAMPLE_BYTES"],
        defaultValue: null,
        minimum: 1,
        maximum: Number.MAX_SAFE_INTEGER,
      },
    ],
    { "Number.MAX_SAFE_INTEGER": Number.MAX_SAFE_INTEGER },
  );
  expect(failures).toEqual([
    'REA_FIXED: documented Restart-only numeric limits default "30", floor "30", maximum "30", but code exports no bound',
  ]);
});
