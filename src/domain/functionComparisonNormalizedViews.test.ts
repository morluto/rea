import { describe, expect, it } from "vitest";

import {
  ADD_PEOPLE_LEFT,
  ADD_PEOPLE_RIGHT,
  INITIALIZE_PEOPLE_LEFT,
  INITIALIZE_PEOPLE_RIGHT,
  USE_GADGET_LEFT,
  USE_GADGET_RIGHT,
  wallaceDossier,
} from "./functionComparisonNormalizedViews.fixture.js";
import {
  compareFunctions as compareSnapshots,
  type FunctionComparisonRequest,
} from "./functionComparison.js";
import { functionSnapshotFixture } from "./functionDossierEvidence.fixture.js";
import { functionComparisonResultSchema } from "./functionComparisonSchemas.js";
import { createEvidence, type Evidence } from "./evidence.js";
import { createEvidenceBundle } from "./evidenceBundle.js";
import { findChangedBehavior } from "./changedBehavior.js";
import { verifyReconstruction } from "./reconstructionVerification.js";
import { correlateStaticAndRuntime } from "./staticRuntimeCorrelation.js";
import { functionDossierSchema } from "./hopperValues.js";
import { jsonValueSchema } from "./jsonValue.js";
import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { AnalysisInputError } from "./analysisErrorCore.js";
import { readComparisonResult } from "./comparisonEvidenceResult.js";

/** Authenticate fixture Evidence before the pure snapshot comparison. */
const compareFunctions = (
  left: Evidence,
  right: Evidence,
  request?: FunctionComparisonRequest,
) =>
  compareSnapshots(
    functionSnapshotFixture(left),
    functionSnapshotFixture(right),
    request,
  );

const G_HIDRA = {
  id: "ghidra",
  name: "Ghidra",
  version: "12.1.4",
} as const;

const observe = (
  digest: string,
  dossier: object,
  provider: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  } = G_HIDRA,
): Evidence =>
  createEvidence(
    {
      path: `/tmp/wallace-${digest}`,
      sha256: digest.repeat(64),
      format: "pe",
      architecture: "x86",
    },
    provider,
    {
      operation: "analyze_function",
      parameters: enhancedInputSchemas.analyze_function.parse({
        procedure: "fixture",
      }),
      result: jsonValueSchema.parse(
        functionDossierSchema.parse(wallaceDossier(dossier)),
      ),
      confidence: "observed",
      authority: "shipped-artifact",
    },
  );

const capture = (digit: string): Evidence =>
  createEvidence(
    undefined,
    { id: "fixture", name: "Fixture", version: "1" },
    {
      predicateType: "rea.process-capture",
      operation: "capture_process_scenario",
      parameters: {},
      result: { digit },
      authority: "controlled-replay",
      environment: {
        id: `fixture-${digit}`,
        platform: "test",
        architecture: "test",
        isolation: "process",
      },
    },
  );

const addPeoplePair = () =>
  [observe("1", ADD_PEOPLE_LEFT), observe("2", ADD_PEOPLE_RIGHT)] as const;
const initializePeoplePair = () =>
  [
    observe("3", INITIALIZE_PEOPLE_LEFT),
    observe("4", INITIALIZE_PEOPLE_RIGHT),
  ] as const;
const gadgetPair = () =>
  [observe("5", USE_GADGET_LEFT), observe("6", USE_GADGET_RIGHT)] as const;

const dimension = (result: ReturnType<typeof compareFunctions>, name: string) =>
  result.dimensions.find((item) => item.dimension === name);

const view = (result: ReturnType<typeof compareFunctions>, name: string) =>
  result.normalized_views?.views.find((item) => item.dimension === name);

describe("wallace relocation-only function pair", () => {
  const [left, right] = addPeoplePair();

  it("keeps every exact dimension, count, and status unchanged by normalized views", () => {
    const exact = compareFunctions(left, right);
    const normalized = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(normalized.dimensions).toEqual(exact.dimensions);
    expect(normalized.changes).toEqual(exact.changes);
    expect(normalized.summary).toEqual(exact.summary);
    expect(normalized.status).toBe(exact.status);
    expect(functionComparisonResultSchema.safeParse(normalized).success).toBe(
      true,
    );
  });

  it("reports the unchanged source function as changed in the exact text dimensions", () => {
    const result = compareFunctions(left, right);
    expect(dimension(result, "pseudocode")).toMatchObject({
      status: "changed",
      left_count: 639,
      right_count: 639,
    });
    expect(dimension(result, "assembly")).toMatchObject({ status: "changed" });
    expect(dimension(result, "cfg")).toMatchObject({ status: "unchanged" });
  });

  it("leaves relocation-only views unknown when masked callees cannot be matched", () => {
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    for (const name of ["pseudocode_normalized", "assembly_normalized"]) {
      const projection = view(result, name);
      // Both projections completed, so the unknown view keeps their facts.
      expect(projection?.left_digest).toBe(projection?.right_digest);
      expect(projection, name).toMatchObject({
        status: "unknown",
        conclusion_kind: "unresolved_branch",
        evidence_links: [left.evidence_id, right.evidence_id],
        left_digest: expect.any(String),
        text_delta: null,
        masking: {
          policy: "rea-address-normalized-text-v1",
          left: { address_derived_identifiers: expect.any(Number) },
          right: { address_derived_identifiers: expect.any(Number) },
        },
        limitations: expect.arrayContaining([
          expect.stringContaining(
            "normalized equality cannot establish callee identity or call order",
          ),
        ]),
      });
      expect(projection?.limitations).toEqual(
        expect.arrayContaining([
          expect.stringContaining("do not establish that both sides reference"),
        ]),
      );
    }
  });

  it("rejects duplicate normalized view dimensions", () => {
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    const views = result.normalized_views?.views;
    expect(views).toHaveLength(2);
    const duplicate = {
      ...result,
      normalized_views: {
        ...result.normalized_views!,
        views: [views![0]!, { ...views![1]!, dimension: views![0]!.dimension }],
      },
    };
    expect(functionComparisonResultSchema.safeParse(duplicate).success).toBe(
      false,
    );
  });

  it("masks a relocated function label while leaving equal uncorroborated constants visible", () => {
    const [before, after] = syntheticPair(
      addressRelocationText("0x411700"),
      addressRelocationText("0x4116f0"),
    );
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    const projection = view(result, "pseudocode_normalized");
    // Only the function's own provider-generated name is address-derived.
    expect(projection?.masking?.left).toMatchObject({
      address_derived_identifiers: 1,
      unmasked_address_derived_identifiers: 0,
      corroborated_addresses: 0,
      visible_addresses: 1,
    });
    expect(projection?.masking?.right).toMatchObject({
      address_derived_identifiers: 1,
      unmasked_address_derived_identifiers: 0,
      corroborated_addresses: 0,
      visible_addresses: 1,
    });
    expect(projection).toMatchObject({ status: "unchanged" });
    expect(projection?.left_count).toBe(projection?.right_count);
  });
});

describe("normalized view projected facts and symbol names", () => {
  it("requires projected facts in known normalized views", () => {
    const result = compareFunctions(
      ...syntheticPair(
        addressRelocationText("0x411700"),
        addressRelocationText("0x4116f0"),
      ),
      { includeNormalizedViews: true },
    );
    const views = result.normalized_views!.views;
    expect(views[0]).toMatchObject({ status: "unchanged" });
    const withoutFacts = {
      ...result,
      normalized_views: {
        ...result.normalized_views!,
        views: [
          {
            ...views[0]!,
            left_digest: null,
            right_digest: null,
            left_count: null,
            right_count: null,
            text_delta: null,
          },
          views[1]!,
        ],
      },
    };
    expect(functionComparisonResultSchema.safeParse(withoutFacts).success).toBe(
      false,
    );
  });

  it("ties known statuses to their projected facts", () => {
    const result = compareFunctions(
      ...syntheticPair(
        addressRelocationText("0x411700"),
        addressRelocationText("0x4116f0"),
      ),
      { includeNormalizedViews: true },
    );
    const [unchanged, other] = result.normalized_views!.views;
    expect(unchanged).toMatchObject({ status: "unchanged" });
    const withView = (view: object) => ({
      ...result,
      normalized_views: { ...result.normalized_views!, views: [view, other!] },
    });
    for (const contradiction of [
      { text_delta: { added_lines: 1, removed_lines: 1, hunks: 1 } },
      { right_digest: "0".repeat(64) },
      { right_count: (unchanged!.right_count ?? 0) + 1 },
      { status: "changed" },
    ])
      expect(
        functionComparisonResultSchema.safeParse(
          withView({ ...unchanged!, ...contradiction }),
        ).success,
        JSON.stringify(contradiction),
      ).toBe(false);
  });

  it("keeps projected facts when the bounded diff gives up", () => {
    const make = (base: string, prefix: string) => ({
      ...addressRelocationText(base),
      pseudocode: `void f(void) {\n${Array.from(
        { length: 12_000 },
        (_, index) => `  ${prefix}${index} = ${index};`,
      ).join("\n")}\n}`,
    });
    const result = compareFunctions(
      ...syntheticPair(make("0x411700", "a"), make("0x4116f0", "b")),
      { includeNormalizedViews: true },
    );
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
      conclusion_kind: "unresolved_branch",
      text_delta: null,
      left_digest: expect.any(String),
      right_digest: expect.any(String),
      masking: { policy: "rea-address-normalized-text-v1" },
      limitations: expect.arrayContaining([
        expect.stringContaining("Bounded line diff exceeded"),
      ]),
    });
  });

  it.each([
    { source: "default", qualifier: "", masked: 1, status: "unchanged" },
    { source: "user_defined", qualifier: "", masked: 0, status: "changed" },
    { source: "user_defined", qualifier: "ns::", masked: 0, status: "changed" },
    {
      source: "user_defined",
      qualifier: "std::vector<int>::",
      masked: 0,
      status: "changed",
    },
  ] as const)(
    "masks an address-shaped name only without a named symbol origin ($source, $qualifier)",
    ({ source, qualifier, masked, status }) => {
      const withSymbol = (address: string) => {
        const dossier = addressRelocationText(address);
        const name = `${qualifier}${dossier.procedure.name}`;
        return {
          ...dossier,
          pseudocode: dossier.pseudocode.replace(dossier.procedure.name, name),
          procedure: {
            ...dossier.procedure,
            name,
            symbol: {
              primary: true,
              dynamic: false,
              external: false,
              type: "function",
              source,
            },
          },
        };
      };
      const result = compareFunctions(
        ...syntheticPair(withSymbol("0x411700"), withSymbol("0x4116f0")),
        { includeNormalizedViews: true },
      );
      const projection = view(result, "pseudocode_normalized");
      for (const side of ["left", "right"] as const)
        expect(projection?.masking?.[side]).toMatchObject({
          address_derived_identifiers: masked,
          unmasked_address_derived_identifiers: 1 - masked,
        });
      expect(projection).toMatchObject({ status });
    },
  );
});

describe("wallace edited function pairs", () => {
  it.each([
    ["initializePeople", initializePeoplePair],
    ["gadget function", gadgetPair],
  ] as const)("keeps %s changed in the normalized views", (_name, pair) => {
    const [before, after] = pair();
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
    });
    expect(view(result, "assembly_normalized")).toMatchObject({
      status: "changed",
    });
    expect(dimension(result, "pseudocode")).toMatchObject({
      status: "changed",
    });
  });

  it("keeps uncorroborated constants visible in normalized pseudocode", () => {
    const [before, after] = initializePeoplePair();
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    const projection = view(result, "pseudocode_normalized");
    // `local_c % 3` and the dropped `rand()` call are ordinary text, so the
    // masked digests differ for the same reason the exact digests do.
    expect(projection?.left_digest).not.toBe(projection?.right_digest);
    // The debug-fill loop bounds stay readable on both sides.
    expect(projection?.masking?.left.visible_addresses).toBe(3);
    expect(projection?.masking?.right.visible_addresses).toBe(3);
  });
});

const syntheticDossier = (input: {
  readonly base: string;
  readonly name: string;
  readonly pseudocode: string;
  readonly assembly: readonly string[];
  readonly body?: boolean;
  readonly procedureThunkTarget?: string;
  readonly callees?: readonly {
    readonly address: string;
    readonly name: string;
    readonly thunk_target?: string;
  }[];
  readonly callers?: readonly {
    readonly address: string;
    readonly name: string;
  }[];
  readonly outgoingReferences?: readonly {
    readonly source: string;
    readonly target: string;
    readonly operandIndex: number;
  }[];
  readonly referencedNames?: readonly {
    readonly address: string;
    readonly source_address: string;
    readonly value: string;
  }[];
  readonly basicBlockSuccessors?: readonly string[];
}) => ({
  procedure: {
    address: input.base,
    name: input.name,
    classification:
      input.procedureThunkTarget === undefined
        ? null
        : {
            external: false,
            thunk: true,
            thunk_target: input.procedureThunkTarget,
            provenance: "fixture",
          },
    body:
      input.body === false
        ? { available: false as const, reason: "extent not observed" }
        : {
            available: true as const,
            provenance: "fixture",
            ranges: [
              {
                start: input.base,
                end: `0x${(BigInt(input.base) + 0x20n).toString(16)}`,
              },
            ],
            total_bytes: 0x21,
            span_bytes: 0x21,
            non_contiguous: false,
            contains_entry: true,
          },
    signature: "int helper(void)",
    locals: [],
  },
  pseudocode: input.pseudocode,
  assembly: [...input.assembly],
  comments: [],
  callers: (input.callers ?? []).map(({ address, name }) => ({
    address,
    name,
    classification: null,
    body: { available: false as const, reason: "extent not observed" },
  })),
  callees: (input.callees ?? []).map(({ address, name, thunk_target }) => ({
    address,
    name,
    classification:
      thunk_target === undefined
        ? null
        : {
            external: false,
            thunk: true,
            thunk_target,
            provenance: "fixture",
          },
    body: { available: false as const, reason: "extent not observed" },
  })),
  incoming_references: [],
  outgoing_references: (input.outgoingReferences ?? []).map(
    ({ source, target, operandIndex }) => ({
      source_address: source,
      target_address: target,
      source_procedure: null,
      target_procedure: null,
      kind: {
        available: true as const,
        provenance: "fixture",
        type: "DATA",
        flow: false,
        call: false,
        jump: false,
        data: true,
        read: true,
        write: false,
        indirect: false,
        computed: false,
        conditional: false,
        terminal: false,
        primary: true,
        operand_index: operandIndex,
        external: true,
      },
    }),
  ),
  referenced_strings: [],
  referenced_names: [...(input.referencedNames ?? [])],
  basic_blocks: [
    {
      start: input.base,
      end: `0x${(BigInt(input.base) + 0x20n).toString(16)}`,
      successors: [...(input.basicBlockSuccessors ?? [])],
    },
  ],
  native_api: null,
  native_value_flow: null,
  limitations: [],
});

const syntheticPair = (
  left: object,
  right: object,
  rightProvider: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
  } = G_HIDRA,
) => [observe("7", left), observe("8", right, rightProvider)] as const;

const relocatedText = (
  address: string,
  options: { readonly body?: boolean } = {},
) => {
  const own = `FUN_${BigInt(address).toString(16).padStart(8, "0")}`;
  return syntheticDossier({
    base: address,
    name: own,
    pseudocode: `void ${own}(void) {\n  thunk_FUN_00411860(index % 3);\n  if (strcmp(a,"b") == 0) return;\n  stack:0xffffffffffffff3c;\n}\n`,
    assembly: [`${address}: PUSH EBP`, `${address}: CALL 0x00411195`],
    callees: [
      {
        address: "0x411195",
        name: "thunk_FUN_00411860",
        thunk_target: "0x411860",
      },
    ],
    ...options,
  });
};

const addressRelocationText = (address: string) => {
  const name = `FUN_${BigInt(address).toString(16).padStart(8, "0")}`;
  const nextInstruction = `0x${(BigInt(address) + 1n).toString(16)}`;
  return syntheticDossier({
    base: address,
    name,
    pseudocode: `void ${name}(void) { if (size == 0x1000) return; }`,
    assembly: [`${address}: PUSH EBP`, `${nextInstruction}: CALL 0x00411195`],
  });
};

const relocatedPseudocode = (address: string, body: string) =>
  `void FUN_${BigInt(address).toString(16).padStart(8, "0")}(void) { ${body}; }`;

const unresolvedCallPair = () => {
  const make = (base: string, target: string) =>
    syntheticDossier({
      base,
      name: `FUN_${BigInt(base).toString(16)}`,
      pseudocode: `void f(void) { FUN_${BigInt(target).toString(16)}(); }`,
      assembly: [`${base}: CALL ${target}`],
      callees: [
        { address: target, name: `FUN_${BigInt(target).toString(16)}` },
      ],
    });
  return syntheticPair(
    make("0x411700", "0x411860"),
    make("0x511700", "0x5118a0"),
  );
};

describe("normalized view edge cases", () => {
  it("reports a relocated pair as unchanged without touching exact statuses", () => {
    const [left, right] = syntheticPair(
      addressRelocationText("0x411700"),
      addressRelocationText("0x4116f0"),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(
      result.dimensions.map(({ dimension, status }) => [dimension, status]),
    ).toEqual(
      expect.arrayContaining([
        ["assembly", "changed"],
        ["cfg", "unchanged"],
      ]),
    );
    for (const name of ["pseudocode_normalized", "assembly_normalized"]) {
      expect(view(result, name)).toMatchObject({ status: "unchanged" });
      expect(
        view(result, name)?.masking?.rules.map(({ rule }) => rule),
      ).toEqual([
        "address_derived_identifier",
        "function_relative_address",
        "corroborated_external_address",
      ]);
    }
  });

  it.each([
    ["a small numeric constant", "index % 3", "index % 5"],
    ["a mnemonic", "index % 3", "index % 4"],
    ["a named symbol", 'strcmp(a,"b")', 'strlen(a,"b")'],
    ["a literal", '"b"', '"c"'],
    ["an uncorroborated address-derived label", "FUN_00411700", "FUN_00c0ffee"],
    ["a non-default address space", "stack:0xffff00", "stack:0xffff08"],
  ])("keeps a changed %s visible", (_name, from, to) => {
    const [left, right] = syntheticPair(
      {
        ...relocatedText("0x411700"),
        pseudocode: relocatedPseudocode("0x411700", from),
      },
      {
        ...relocatedText("0x4116f0"),
        pseudocode: relocatedPseudocode("0x4116f0", to),
      },
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
    });
  });
});

describe("normalized view operand address coverage", () => {
  it.each([
    ["semicolon comment", "EAX, [{target}] ; 0x30 bytes", "unchanged"],
    ["line comment", "EAX, [{target}] // 0x30 bytes", "unchanged"],
    ["block comment", "EAX, [{target}] /* 0x30 bytes */", "unchanged"],
    [
      "multiline block comment",
      "EAX, [{target}] /* 0x30\nbytes */",
      "unchanged",
    ],
    ["quoted operand", 'EAX, "0x30", [{target}]', "unchanged"],
    ["escaped quote", 'EAX, "escaped \\"0x30\\"", [{target}]', "unchanged"],
    ["comment inside operand", "EAX, [{target} /* 0x30 bytes */]", "unchanged"],
    ["same address in comment", "EAX, [{target}] ; 0x9000", "unchanged"],
    ["additional numeric use", "EAX, [{target} + 0x30] ; comment", "changed"],
    ["repeated numeric use", "EAX, [{target} + {target}]", "changed"],
  ] as const)(
    "counts instruction uses independently of %s",
    (_name, operands, status) => {
      const make = (base: string, target: string) =>
        syntheticDossier({
          base,
          name: `FUN_${BigInt(base).toString(16)}`,
          pseudocode: "void f(void) {}",
          assembly: [`${base}: MOV ${operands.replaceAll("{target}", target)}`],
          referencedNames: [
            { address: target, source_address: base, value: "name" },
          ],
        });
      const [left, right] = syntheticPair(
        make("0x411700", "0x9000"),
        make("0x511700", "0xa000"),
      );
      expect(
        view(
          compareFunctions(left, right, { includeNormalizedViews: true }),
          "assembly_normalized",
        )?.status,
      ).toBe(status);
    },
  );
});

describe("normalized view long assembly lines", () => {
  it.each([
    ["many operands", false],
    ["many operands", true],
    ["one expression", false],
    ["one expression", true],
  ] as const)(
    "preserves reference uniqueness in long lines with %s (repeated target: %s)",
    (form, repeated) => {
      const constants = Array.from({ length: 2_000 }, () => "0x30");
      const make = (base: string, target: string) => {
        const use = repeated ? `${target} + ${target}` : target;
        const operand =
          form === "many operands"
            ? `${constants.join(", ")}, [${use}]`
            : `[${constants.join(" + ")} + ${use}]`;
        return syntheticDossier({
          base,
          name: `FUN_${BigInt(base).toString(16)}`,
          pseudocode: "void f(void) {}",
          assembly: [`${base}: MOV EAX, ${operand} ; preserved comment`],
          outgoingReferences: [
            {
              source: base,
              target,
              operandIndex: form === "many operands" ? constants.length + 1 : 1,
            },
          ],
        });
      };
      const [left, right] = syntheticPair(
        make("0x411700", "0x9000"),
        make("0x511700", "0xa000"),
      );
      const result = compareFunctions(left, right, {
        includeNormalizedViews: true,
      });
      expect(view(result, "assembly_normalized")).toMatchObject({
        status: repeated ? "changed" : "unchanged",
      });
    },
  );
});

describe("normalized view address projection", () => {
  it("keeps distinct in-body branch offsets distinct", () => {
    const [left, right] = syntheticPair(
      syntheticDossier({
        base: "0x411700",
        name: "FUN_00411700",
        pseudocode: "void f(void) {}",
        assembly: ["0x411700: JMP 0x411710"],
      }),
      syntheticDossier({
        base: "0x511700",
        name: "FUN_00511700",
        pseudocode: "void f(void) {}",
        assembly: ["0x511700: JMP 0x511720"],
      }),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "assembly_normalized")).toMatchObject({
      status: "changed",
    });
  });

  it("does not mask a numeric constant just because the same value is a referenced name address", () => {
    const [left, right] = syntheticPair(
      syntheticDossier({
        base: "0x411700",
        name: "FUN_00411700",
        pseudocode: "void f(void) { if (size == 0x1000) return; }",
        assembly: [],
        referencedNames: [
          { address: "0x1000", source_address: "0x411710", value: "name" },
        ],
      }),
      syntheticDossier({
        base: "0x511700",
        name: "FUN_00511700",
        pseudocode: "void f(void) { if (size == 0x2000) return; }",
        assembly: [],
        referencedNames: [
          { address: "0x2000", source_address: "0x511710", value: "name" },
        ],
      }),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
    });
  });

  it("masks a numeric address only at its observed instruction and operand", () => {
    const make = (base: string, target: string, operandIndex: number) =>
      syntheticDossier({
        base,
        name: `FUN_${BigInt(base).toString(16)}`,
        pseudocode: "void f(void) {}",
        assembly: [`${base}: MOV EAX, [${target}]`],
        outgoingReferences: [{ source: base, target, operandIndex }],
      });
    const [left, right] = syntheticPair(
      make("0x411700", "0x1000", 1),
      make("0x511700", "0x2000", 1),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "assembly_normalized")).toMatchObject({
      status: "unchanged",
    });

    const [wrongOperandLeft, wrongOperandRight] = syntheticPair(
      make("0x411700", "0x1000", 0),
      make("0x511700", "0x2000", 0),
    );
    const wrongOperand = compareFunctions(wrongOperandLeft, wrongOperandRight, {
      includeNormalizedViews: true,
    });
    expect(view(wrongOperand, "assembly_normalized")).toMatchObject({
      status: "changed",
    });
  });

  it.each(["overlay:0x1010", "overlay: 0x1010"])(
    "keeps address-space-qualified targets visible (%s)",
    (leftTarget) => {
      const rightTarget = leftTarget.replace("0x1010", "0x2010");
      const make = (base: string, target: string) =>
        syntheticDossier({
          base,
          name: `FUN_${BigInt(base).toString(16)}`,
          pseudocode: "void f(void) {}",
          assembly: [`${base}: JMP ${target}`],
        });
      const [left, right] = syntheticPair(
        make("0x1000", leftTarget),
        make("0x2000", rightTarget),
      );
      const result = compareFunctions(left, right, {
        includeNormalizedViews: true,
      });
      expect(view(result, "assembly_normalized")).toMatchObject({
        status: "changed",
      });
    },
  );

  it("preserves each provider label when multiple forms share one address", () => {
    const [left, right] = syntheticPair(
      syntheticDossier({
        base: "0x411700",
        name: "FUN_00411700",
        pseudocode: "void f(void) { FUN_00411860(); DAT_00411860; }",
        assembly: [],
        callees: [{ address: "0x411860", name: "FUN_00411860" }],
      }),
      syntheticDossier({
        base: "0x511700",
        name: "FUN_00511700",
        pseudocode: "void f(void) { FUN_00511860(); LAB_00511860; }",
        assembly: [],
        callees: [{ address: "0x511860", name: "FUN_00511860" }],
      }),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
    });
  });
});

describe("normalized view lexical safety and callee identity", () => {
  it.each([
    ["quoted hexadecimal address", 'puts("0x411700")', 'puts("0x4116f0")'],
    [
      "quoted generated identifier",
      'puts("FUN_00411700")',
      'puts("FUN_004116f0")',
    ],
    [
      "address in a line comment",
      "return 0; // 0x411700",
      "return 0; // 0x4116f0",
    ],
  ])("preserves %s text during normalization", (_name, from, to) => {
    const [left, right] = syntheticPair(
      {
        ...relocatedText("0x411700"),
        pseudocode: relocatedPseudocode("0x411700", from),
      },
      {
        ...relocatedText("0x4116f0"),
        pseudocode: relocatedPseudocode("0x4116f0", to),
      },
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
    });
  });

  it("preserves address-looking assembly comments", () => {
    const [left, right] = syntheticPair(
      {
        ...relocatedText("0x411700"),
        assembly: ["0x411700: NOP ; 0x411700"],
      },
      {
        ...relocatedText("0x4116f0"),
        assembly: ["0x4116f0: NOP ; 0x4116f0"],
      },
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "assembly_normalized")).toMatchObject({
      status: "changed",
    });
  });
});

describe("normalized view callee identity", () => {
  it("reports equal ordinalized text as unknown when exact calls cannot establish callee identity", () => {
    const left = syntheticDossier({
      base: "0x411700",
      name: "FUN_00411700",
      pseudocode: "void FUN_00411700(void) { FUN_00411860(); }",
      assembly: ["CALL 0x00411860"],
      callees: [{ address: "0x411860", name: "FUN_00411860" }],
    });
    const right = syntheticDossier({
      base: "0x511700",
      name: "FUN_00511700",
      pseudocode: "void FUN_00511700(void) { FUN_00511860(); }",
      assembly: ["CALL 0x00511860"],
      callees: [{ address: "0x511860", name: "FUN_00511860" }],
    });
    const [before, after] = syntheticPair(left, right);
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    expect(dimension(result, "calls")).toMatchObject({ status: "unknown" });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
      limitations: expect.arrayContaining([
        expect.stringContaining(
          "cannot establish callee identity or call order",
        ),
      ]),
    });
  });

  it("does not treat independently numbered reordered callees as proven equal", () => {
    const make = (base: string, first: string, second: string) =>
      syntheticDossier({
        base,
        name: `FUN_${BigInt(base).toString(16)}`,
        pseudocode: `void f(void) { FUN_${BigInt(first).toString(16)}(); FUN_${BigInt(second).toString(16)}(); }`,
        assembly: [`CALL ${first}`, `CALL ${second}`],
        callees: [
          { address: first, name: `FUN_${BigInt(first).toString(16)}` },
          { address: second, name: `FUN_${BigInt(second).toString(16)}` },
        ],
      });
    const [before, after] = syntheticPair(
      make("0x411700", "0x411860", "0x4118a0"),
      make("0x511700", "0x5118a0", "0x511860"),
    );
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
    });
  });

  it("treats the procedure's own thunk target as a masked callee", () => {
    const make = (base: string, target: string, otherCallee: string) =>
      syntheticDossier({
        base,
        name: `FUN_${BigInt(base).toString(16)}`,
        procedureThunkTarget: target,
        pseudocode: "void thunk(void) {}",
        assembly: [`${base}: JMP ${target}`],
        callers: [
          {
            address: otherCallee,
            name: `FUN_${BigInt(otherCallee).toString(16)}`,
          },
        ],
      });
    const [left, right] = syntheticPair(
      make("0x411700", "0x411860", "0x4118a0"),
      make("0x511700", "0x511860", "0x5118a0"),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(dimension(result, "calls")).toMatchObject({ status: "unknown" });
    expect(view(result, "assembly_normalized")).toMatchObject({
      status: "unknown",
      limitations: expect.arrayContaining([
        expect.stringContaining(
          "cannot establish callee identity or call order",
        ),
      ]),
    });
  });
});

describe("normalized view outgoing callee facts", () => {
  it.each([
    { edge: "call", call: true, jump: false },
    { edge: "tail jump", call: false, jump: true },
  ] as const)(
    "treats a typed outgoing $edge target missing from callees as a masked callee",
    ({ call, jump }) => {
      const make = (base: string, target: string) => {
        const name = `FUN_${BigInt(target).toString(16)}`;
        const dossier = syntheticDossier({
          base,
          name: `FUN_${BigInt(base).toString(16)}`,
          pseudocode: `void f(void) { ${name}(); }`,
          assembly: [`${base}: ${call ? "CALL" : "JMP"} ${target}`],
          outgoingReferences: [{ source: base, target, operandIndex: 0 }],
        });
        const edge = dossier.outgoing_references[0]!;
        return {
          ...dossier,
          outgoing_references: [
            {
              ...edge,
              target_procedure: {
                address: target,
                name,
                classification: null,
                body: {
                  available: false as const,
                  reason: "extent not observed",
                },
              },
              kind: {
                ...edge.kind,
                type: call ? "UNCONDITIONAL_CALL" : "UNCONDITIONAL_JUMP",
                flow: true,
                call,
                jump,
                data: false,
                read: false,
              },
            },
          ],
        };
      };
      const [before, after] = syntheticPair(
        make("0x411700", "0x411860"),
        make("0x511700", "0x511860"),
      );
      const result = compareFunctions(before, after, {
        includeNormalizedViews: true,
      });
      expect(dimension(result, "calls")).toMatchObject({ status: "unknown" });
      for (const name of ["pseudocode_normalized", "assembly_normalized"])
        expect(view(result, name), name).toMatchObject({
          status: "unknown",
          limitations: expect.arrayContaining([
            expect.stringContaining(
              "cannot establish callee identity or call order",
            ),
          ]),
        });
    },
  );
});

describe("normalized view callee facts beyond typed edges", () => {
  it("treats the containing procedure of an interior call target as a masked callee", () => {
    const make = (base: string, entry: string, interior: string) => {
      const name = `FUN_${BigInt(entry).toString(16)}`;
      const dossier = syntheticDossier({
        base,
        name: `FUN_${BigInt(base).toString(16)}`,
        pseudocode: `void f(void) { ${name}(); }`,
        assembly: [`${base}: CALL ${interior}`],
        outgoingReferences: [
          { source: base, target: interior, operandIndex: 0 },
        ],
      });
      const edge = dossier.outgoing_references[0]!;
      return {
        ...dossier,
        outgoing_references: [
          {
            ...edge,
            target_procedure: {
              address: entry,
              name,
              classification: null,
              body: {
                available: false as const,
                reason: "extent not observed",
              },
            },
            kind: {
              ...edge.kind,
              type: "UNCONDITIONAL_CALL",
              flow: true,
              call: true,
              data: false,
              read: false,
            },
          },
        ],
      };
    };
    const [before, after] = syntheticPair(
      make("0x411700", "0x411860", "0x411870"),
      make("0x511700", "0x511860", "0x511870"),
    );
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    expect(dimension(result, "calls")).toMatchObject({ status: "unknown" });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
      limitations: expect.arrayContaining([
        expect.stringContaining(
          "cannot establish callee identity or call order",
        ),
      ]),
    });
  });

  it.each([
    { classification: "direct", providerType: 2 },
    { classification: "unknown", providerType: 1 },
  ] as const)(
    "treats a Hopper call reference classified $classification without reference flags as a masked callee",
    ({ classification, providerType }) => {
      const make = (base: string, target: string) => {
        const name = `FUN_${BigInt(target).toString(16)}`;
        const dossier = syntheticDossier({
          base,
          name: `FUN_${BigInt(base).toString(16)}`,
          pseudocode: `void f(void) { ${name}(); }`,
          assembly: [`${base}: CALL ${target}`],
        });
        return {
          ...dossier,
          // Hopper reports a call classification without detailed reference flags.
          outgoing_references: [
            {
              source_address: base,
              target_address: target,
              source_procedure: null,
              target_procedure: null,
              kind: {
                available: false as const,
                reason: "detailed reference flags unavailable",
              },
              call: {
                classification,
                provider_type: providerType,
                provenance: "fixture",
              },
            },
          ],
        };
      };
      const [before, after] = syntheticPair(
        make("0x411700", "0x411860"),
        make("0x511700", "0x511860"),
      );
      const result = compareFunctions(before, after, {
        includeNormalizedViews: true,
      });
      expect(dimension(result, "calls")).toMatchObject({ status: "unknown" });
      for (const name of ["pseudocode_normalized", "assembly_normalized"])
        expect(view(result, name), name).toMatchObject({
          status: "unknown",
          limitations: expect.arrayContaining([
            expect.stringContaining(
              "cannot establish callee identity or call order",
            ),
          ]),
        });
    },
  );
});

describe("normalized view fail-closed parsing", () => {
  it.each([
    ["unterminated literal", 'puts("0x411700)'],
    ["unterminated block comment", "return 0; /* 0x411700"],
    ["unsupported raw string literal", 'puts(R"tag(0x411700)tag")'],
    ["unsupported Rust raw string literal", 'puts(r#"0x411700"#)'],
    ["unsupported Rust raw string without hashes", 'puts(r"0x411700")'],
  ])("fails closed on %s", (_name, pseudocode) => {
    const [left, right] = syntheticPair(
      {
        ...relocatedText("0x411700"),
        pseudocode: `void f(void) { ${pseudocode}; }`,
      },
      relocatedText("0x4116f0"),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    // Only the left text is malformed, and the limitation names that side.
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
      masking: null,
      limitations: expect.arrayContaining([
        expect.stringMatching(
          /^Left provider text .*normalization was skipped/u,
        ),
      ]),
    });
  });
});

describe("normalized view edge cases", () => {
  it("leaves an unobserved function extent masked by ordinal and reports it", () => {
    const [left, right] = syntheticPair(
      relocatedText("0x411700", { body: false }),
      relocatedText("0x4116f0"),
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
      limitations: expect.arrayContaining([
        expect.stringContaining("did not observe its own function body extent"),
      ]),
    });
    expect(view(result, "assembly_normalized")).toMatchObject({
      status: "unknown",
    });
  });

  it("leaves provider-specific text unresolved in both views", () => {
    const [left, right] = syntheticPair(
      relocatedText("0x411700"),
      relocatedText("0x4116f0"),
      { id: "ida", name: "IDA", version: "9.1" },
    );
    const result = compareFunctions(left, right, {
      includeNormalizedViews: true,
    });
    for (const name of ["pseudocode_normalized", "assembly_normalized"]) {
      expect(view(result, name)).toMatchObject({
        status: "unknown",
        masking: null,
        conclusion_kind: "unresolved_branch",
        limitations: expect.arrayContaining([
          expect.stringContaining("requires one provider identity"),
        ]),
      });
    }
    expect(result.summary.unknown).toBe(
      result.dimensions.filter(({ status }) => status === "unknown").length,
    );
  });

  it("omits normalized views unless the caller opts in", () => {
    const [left, right] = syntheticPair(
      relocatedText("0x411700"),
      relocatedText("0x4116f0"),
    );
    expect(compareFunctions(left, right).normalized_views).toBeUndefined();
  });
});

const comparisonEvidence = (
  left: Evidence,
  right: Evidence,
  includeNormalizedViews: boolean,
): Evidence =>
  createEvidence(
    undefined,
    {
      id: "rea-function-comparison",
      name: "REA function comparison",
      version: "1",
    },
    {
      predicateType: "rea.function-comparison",
      operation: "compare_functions",
      parameters: {
        left_evidence_id: left.evidence_id,
        right_evidence_id: right.evidence_id,
        ...(includeNormalizedViews ? { include_normalized_views: true } : {}),
      },
      result: jsonValueSchema.parse(
        compareFunctions(left, right, { includeNormalizedViews }),
      ),
      confidence: "derived",
      authority: "analyst-inference",
      evidenceLinks: [left.evidence_id, right.evidence_id],
    },
  );

const claim = (dimension: string, evidence: Evidence) => ({
  name: "Relocated function",
  claims: [
    {
      kind: "structural-function" as const,
      claim_id: "normalized",
      title: "Address-normalized pseudocode agrees",
      comparison_evidence_id: evidence.evidence_id,
      dimension,
    },
  ],
});

describe("normalized view consumers", () => {
  const [relocatedLeft, relocatedRight] = addPeoplePair();
  const [editedLeft, editedRight] = initializePeoplePair();

  it("verifies a declared normalized claim from the requested view", () => {
    const [before, after] = syntheticPair(
      addressRelocationText("0x411700"),
      addressRelocationText("0x4116f0"),
    );
    const evidence = comparisonEvidence(before, after, true);
    const bundle = createEvidenceBundle([before, after, evidence]);
    const result = verifyReconstruction(
      claim("pseudocode_normalized", evidence),
      bundle,
    );
    expect(result.claims.items).toMatchObject([
      {
        status: "pass",
        observed_status: "unchanged",
        dimension: "pseudocode_normalized",
      },
    ]);
  });

  it("rejects a normalized claim the comparison never produced", () => {
    const evidence = comparisonEvidence(relocatedLeft, relocatedRight, false);
    const bundle = createEvidenceBundle([
      relocatedLeft,
      relocatedRight,
      evidence,
    ]);
    try {
      verifyReconstruction(claim("pseudocode_normalized", evidence), bundle);
      throw new Error("Expected an unrequested normalized view to be rejected");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AnalysisInputError);
      expect(error).toMatchObject({
        userMessage: expect.stringMatching(
          /normalized view was not requested/u,
        ),
        issues: [
          {
            path: ["claims", 0, "dimension"],
            reason: "invalid_value",
            message: expect.stringMatching(
              /normalized view was not requested/u,
            ),
          },
        ],
      });
    }
  });

  it("preserves selected normalized-view limitations in reconstruction claims", () => {
    const [before, after] = unresolvedCallPair();
    const evidence = comparisonEvidence(before, after, true);
    const bundle = createEvidenceBundle([before, after, evidence]);
    const result = verifyReconstruction(
      claim("pseudocode_normalized", evidence),
      bundle,
    );
    expect(result.claims.items[0]?.limitations).toContain(
      "Masked text references a dossier-listed callee or thunk target while the exact calls dimension is unknown; normalized equality cannot establish callee identity or call order.",
    );
  });

  it("reports unresolved normalized findings when relocation masks unknown callees", () => {
    const findings = findChangedBehavior({
      comparisons: [comparisonEvidence(relocatedLeft, relocatedRight, true)],
    }).result.findings.items;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "pseudocode_normalized",
          status: "unknown",
          classification: "unresolved_branch",
        }),
      ]),
    );
    expect(findings.map(({ dimension }) => dimension)).toContain("pseudocode");
  });

  it("reports a normalized change as its own static candidate", () => {
    const findings = findChangedBehavior({
      comparisons: [comparisonEvidence(editedLeft, editedRight, true)],
    }).result.findings.items;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          dimension: "pseudocode_normalized",
          status: "changed",
        }),
      ]),
    );
  });
});

describe("normalized view static/runtime consumer", () => {
  const [editedLeft, editedRight] = initializePeoplePair();

  it("selects a normalized view for a static/runtime hypothesis", () => {
    const staticEvidence = comparisonEvidence(editedLeft, editedRight, true);
    const runtime = createEvidence(
      undefined,
      {
        id: "rea-process",
        name: "REA deterministic process harness",
        version: "3",
      },
      {
        predicateType: "rea.process-comparison",
        operation: "compare_process_captures",
        parameters: {
          left_evidence_id: capture("1").evidence_id,
          right_evidence_id: capture("2").evidence_id,
        },
        result: {
          status: "changed",
          terminal: "changed",
          interaction: "unchanged",
          exit: "unchanged",
          filesystem: "unchanged",
          process: "unchanged",
          first_divergence: {
            status: "found",
            dimension: "terminal",
            index: 0,
            left_at_ms: 0,
            right_at_ms: 0,
            left: "left",
            right: "right",
          },
          limitations: [],
        },
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: [capture("1").evidence_id, capture("2").evidence_id],
      },
    );
    const correlate = (
      dimension: string,
      comparison: Evidence = staticEvidence,
    ) =>
      correlateStaticAndRuntime({
        static_comparisons: [comparison],
        runtime_comparisons: [runtime],
        mappings: [
          {
            static: {
              comparison_evidence_id: comparison.evidence_id,
              selector: { kind: "function", dimension },
            },
            runtime: {
              comparison_evidence_id: runtime.evidence_id,
              dimension: "terminal",
            },
            side_alignment: "left_to_left",
            hypothesis: {
              statement:
                "The static edit is associated with terminal behavior.",
              expected_pattern: "cochanged",
            },
          },
        ],
      });
    expect(correlate("pseudocode_normalized").correlations.items).toMatchObject(
      [{ observed_pattern: "cochanged", classification: "hypothesis" }],
    );
    expect(correlate("pseudocode")).toMatchObject({ status: "correlated" });
    try {
      correlate(
        "pseudocode_normalized",
        comparisonEvidence(editedLeft, editedRight, false),
      );
      throw new Error("Expected an unrequested normalized view to be rejected");
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AnalysisInputError);
      expect(error).toMatchObject({
        userMessage: expect.stringMatching(/requested normalized view/u),
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["mappings", 0, "static", "selector"],
            reason: "invalid_value",
          }),
        ]),
      });
    }

    const [uncertainLeft, uncertainRight] = unresolvedCallPair();
    const uncertainComparison = comparisonEvidence(
      uncertainLeft,
      uncertainRight,
      true,
    );
    expect(
      correlate("pseudocode_normalized", uncertainComparison).correlations
        .items[0]?.limitations,
    ).toContain(
      "Masked text references a dossier-listed callee or thunk target while the exact calls dimension is unknown; normalized equality cannot establish callee identity or call order.",
    );

    const outsideClosure = capture("9").evidence_id;
    const result = functionComparisonResultSchema.parse(
      staticEvidence.normalized_result,
    );
    const views = result.normalized_views!.views.map((item, index) =>
      index === 0
        ? {
            ...item,
            evidence_links: [outsideClosure, item.evidence_links[1]!],
          }
        : item,
    );
    const unclosedComparison = createEvidence(
      undefined,
      staticEvidence.provider,
      {
        predicateType: "rea.function-comparison",
        operation: "compare_functions",
        parameters: staticEvidence.parameters,
        result: jsonValueSchema.parse({
          ...result,
          normalized_views: { ...result.normalized_views!, views },
        }),
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: staticEvidence.evidence_links,
      },
    );
    expect(() =>
      correlate("pseudocode_normalized", unclosedComparison),
    ).toThrow(/outside its top-level closure/u);
    expect(() =>
      verifyReconstruction(
        claim("assembly_normalized", unclosedComparison),
        createEvidenceBundle([editedLeft, editedRight, unclosedComparison]),
      ),
    ).toThrow(/outside its top-level closure/u);
  });
});

it.each([
  [
    "indirect branch displacement",
    "[EAX + 0x1010]",
    "[EAX + 0x2010]",
    "changed",
  ],
  ["semicolon comment", "0x1010 ; loop", "0x2010 ; loop", "unchanged"],
  ["line comment", "0x1010 // loop", "0x2010 // loop", "unchanged"],
  ["block comment", "0x1010 /* loop */", "0x2010 /* loop */", "unchanged"],
] as const)(
  "normalizes only direct branch targets before %s",
  (_name, leftOperand, rightOperand, status) => {
    const pair = ["0x1000", "0x2000"].map((address, index) =>
      observe(String(index + 1), {
        ...ADD_PEOPLE_LEFT,
        procedure: {
          ...ADD_PEOPLE_LEFT.procedure,
          address,
          body: {
            ...ADD_PEOPLE_LEFT.procedure.body,
            ranges: [
              { start: address, end: index === 0 ? "0x10ff" : "0x20ff" },
            ],
            span_bytes: 256,
            total_bytes: 256,
          },
        },
        assembly: [
          `${address}: JMP ${index === 0 ? leftOperand : rightOperand}`,
        ],
        callees: [],
        outgoing_references: [],
        incoming_references: [],
      }),
    );
    const left = pair[0];
    const right = pair[1];
    if (left === undefined || right === undefined)
      throw new Error("Expected both function snapshots");
    expect(
      view(
        compareFunctions(left, right, { includeNormalizedViews: true }),
        "assembly_normalized",
      )?.status,
    ).toBe(status);
  },
);

describe("normalized view opt-in integrity", () => {
  it.each([
    { recorded: false, produced: true },
    { recorded: true, produced: false },
  ])(
    "rejects comparison Evidence whose views disagree with the recorded opt-in (recorded $recorded, produced $produced)",
    ({ recorded, produced }) => {
      const [before, after] = syntheticPair(
        addressRelocationText("0x411700"),
        addressRelocationText("0x4116f0"),
      );
      const mismatched = createEvidence(
        undefined,
        {
          id: "rea-function-comparison",
          name: "REA function comparison",
          version: "1",
        },
        {
          predicateType: "rea.function-comparison",
          operation: "compare_functions",
          parameters: {
            left_evidence_id: before.evidence_id,
            right_evidence_id: after.evidence_id,
            ...(recorded ? { include_normalized_views: true } : {}),
          },
          result: jsonValueSchema.parse(
            compareFunctions(before, after, {
              includeNormalizedViews: produced,
            }),
          ),
          confidence: "derived",
          authority: "analyst-inference",
          evidenceLinks: [before.evidence_id, after.evidence_id],
        },
      );
      const read = readComparisonResult(mismatched, "compare_functions");
      expect(read.ok).toBe(false);
      expect(read.ok ? undefined : read.error.message).toMatch(
        /include_normalized_views/u,
      );
      expect(
        readComparisonResult(
          comparisonEvidence(before, after, produced),
          "compare_functions",
        ).ok,
      ).toBe(true);
    },
  );
});

describe("normalized view named symbol index", () => {
  it("recognizes a qualified named symbol whose tail contains punctuation", () => {
    const withSymbol = (address: string) => {
      const dossier = addressRelocationText(address);
      const tail = `fcn.${BigInt(address).toString(16).padStart(8, "0")}`;
      const name = `ns::${tail}`;
      return {
        ...dossier,
        pseudocode: dossier.pseudocode.replace(dossier.procedure.name, name),
        procedure: {
          ...dossier.procedure,
          name,
          symbol: {
            primary: true,
            dynamic: false,
            external: false,
            type: "function",
            source: "user_defined" as const,
          },
        },
      };
    };
    const result = compareFunctions(
      ...syntheticPair(withSymbol("0x411700"), withSymbol("0x4116f0")),
      { includeNormalizedViews: true },
    );
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
      masking: { left: { address_derived_identifiers: 0 } },
    });
  });
});

describe("normalized view targets outside the exact calls comparison", () => {
  it("keeps an uncompared tail-jump target unknown even when exact calls are unchanged", () => {
    const make = (base: string, target: string) => {
      const name = `FUN_${BigInt(target).toString(16)}`;
      const dossier = syntheticDossier({
        base,
        name: `FUN_${BigInt(base).toString(16)}`,
        pseudocode: `void f(void) { ${name}(); }`,
        assembly: [`${base}: JMP ${target}`],
        outgoingReferences: [{ source: base, target, operandIndex: 0 }],
      });
      const edge = dossier.outgoing_references[0]!;
      return {
        ...dossier,
        // Complete, empty caller and callee sets: exact calls can be unchanged.
        facet_availability: {
          callers: { available: true as const },
          callees: { available: true as const },
        },
        outgoing_references: [
          {
            ...edge,
            target_procedure: {
              address: target,
              name,
              classification: null,
              body: {
                available: false as const,
                reason: "extent not observed",
              },
            },
            kind: {
              ...edge.kind,
              type: "UNCONDITIONAL_JUMP",
              flow: true,
              jump: true,
              data: false,
              read: false,
            },
          },
        ],
      };
    };
    // Complete relationship coverage, so no call-coverage blocker applies.
    const observeComplete = (digest: string, dossier: object): Evidence =>
      createEvidence(
        {
          path: `/tmp/tail-${digest}`,
          sha256: digest.repeat(64),
          format: "pe",
          architecture: "x86",
        },
        G_HIDRA,
        {
          operation: "analyze_function",
          parameters: enhancedInputSchemas.analyze_function.parse({
            procedure: "fixture",
          }),
          result: jsonValueSchema.parse(
            functionDossierSchema.parse(wallaceDossier(dossier)),
          ),
          confidence: "observed",
          authority: "shipped-artifact",
          relationshipCoverage: { status: "complete" },
        },
      );
    // The tail target moves by a different amount than the function itself.
    const before = observeComplete("7", make("0x411700", "0x411860"));
    const after = observeComplete("8", make("0x511700", "0x5118a0"));
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    expect(dimension(result, "calls")).toMatchObject({ status: "unchanged" });
    for (const name of ["pseudocode_normalized", "assembly_normalized"])
      expect(view(result, name), name).toMatchObject({
        status: "unknown",
        limitations: expect.arrayContaining([
          expect.stringContaining("exact calls dimension does not compare"),
        ]),
      });
  });
});

describe("normalized view callee thunk targets", () => {
  it("keeps a retargeted callee thunk unknown even when exact calls are unchanged", () => {
    const make = (base: string, callee: string, thunkTarget: string) => {
      const dossier = syntheticDossier({
        base,
        name: `FUN_${BigInt(base).toString(16)}`,
        pseudocode: `void f(void) { FUN_${BigInt(thunkTarget).toString(16)}(); }`,
        assembly: [`${base}: PUSH EBP`],
        callees: [
          { address: callee, name: "helper", thunk_target: thunkTarget },
        ],
      });
      return {
        ...dossier,
        facet_availability: {
          callers: { available: true as const },
          callees: { available: true as const },
        },
        // A named callee keeps its identity across builds.
        callees: dossier.callees.map((item) => ({
          ...item,
          symbol: {
            primary: true,
            dynamic: false,
            external: false,
            type: "function",
            source: "user_defined" as const,
          },
        })),
      };
    };
    const observeComplete = (digest: string, dossier: object): Evidence =>
      createEvidence(
        {
          path: `/tmp/thunk-${digest}`,
          sha256: digest.repeat(64),
          format: "pe",
          architecture: "x86",
        },
        G_HIDRA,
        {
          operation: "analyze_function",
          parameters: enhancedInputSchemas.analyze_function.parse({
            procedure: "fixture",
          }),
          result: jsonValueSchema.parse(
            functionDossierSchema.parse(wallaceDossier(dossier)),
          ),
          confidence: "observed",
          authority: "shipped-artifact",
          relationshipCoverage: { status: "complete" },
        },
      );
    // The callee keeps its name while its thunk now points elsewhere.
    const before = observeComplete(
      "7",
      make("0x411700", "0x411800", "0x411860"),
    );
    const after = observeComplete(
      "8",
      make("0x511700", "0x511800", "0x5118a0"),
    );
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    expect(dimension(result, "calls")).toMatchObject({ status: "unchanged" });
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "unknown",
      limitations: expect.arrayContaining([
        expect.stringContaining("exact calls dimension does not compare"),
      ]),
    });
  });
});

describe("normalized view source citations", () => {
  it("rejects a normalized view that does not cite both selected sources", () => {
    const [before, after] = syntheticPair(
      addressRelocationText("0x411700"),
      addressRelocationText("0x4116f0"),
    );
    const result = compareFunctions(before, after, {
      includeNormalizedViews: true,
    });
    const [first, second] = result.normalized_views!.views;
    const evidence = createEvidence(
      undefined,
      {
        id: "rea-function-comparison",
        name: "REA function comparison",
        version: "1",
      },
      {
        predicateType: "rea.function-comparison",
        operation: "compare_functions",
        parameters: {
          left_evidence_id: before.evidence_id,
          right_evidence_id: after.evidence_id,
          include_normalized_views: true,
        },
        result: jsonValueSchema.parse({
          ...result,
          normalized_views: {
            ...result.normalized_views!,
            views: [
              {
                ...first!,
                evidence_links: [before.evidence_id, before.evidence_id],
              },
              second!,
            ],
          },
        }),
        confidence: "derived",
        authority: "analyst-inference",
        evidenceLinks: [before.evidence_id, after.evidence_id],
      },
    );
    const read = readComparisonResult(evidence, "compare_functions");
    expect(read.ok).toBe(false);
    expect(read.ok ? undefined : read.error.message).toMatch(
      /cite both selected/u,
    );
  });

  it("recognizes a named symbol under a long nested template qualifier", () => {
    const qualifier = `${Array.from({ length: 400 }, (_, index) => `n${index}<t${index}>`).join("::")}::`;
    const withSymbol = (address: string) => {
      const dossier = addressRelocationText(address);
      const name = `${qualifier}${dossier.procedure.name}`;
      return {
        ...dossier,
        pseudocode: dossier.pseudocode.replace(dossier.procedure.name, name),
        procedure: {
          ...dossier.procedure,
          name,
          symbol: {
            primary: true,
            dynamic: false,
            external: false,
            type: "function",
            source: "user_defined" as const,
          },
        },
      };
    };
    const result = compareFunctions(
      ...syntheticPair(withSymbol("0x411700"), withSymbol("0x4116f0")),
      { includeNormalizedViews: true },
    );
    expect(view(result, "pseudocode_normalized")).toMatchObject({
      status: "changed",
      masking: { left: { address_derived_identifiers: 0 } },
    });
  });
});
