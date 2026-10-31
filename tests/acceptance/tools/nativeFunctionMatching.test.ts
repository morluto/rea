import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect } from "vitest";
import { cliTest, type TestCli } from "../../support/cli/cliFixture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { connectLocalToolsMcp } from "../../fixtures/localToolsMcp.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import {
  nativeMatchingNamedInventory as nativeMatchingInventory,
  nativeMatchingBody,
  nativeMatchingDetails,
  nativeMatchingTarget,
  nativeMatchingProvider,
} from "../../fixtures/nativeFunctionMatching.js";
import { FUNCTION_COMPARISON_EXAMPLE } from "../../../src/contracts/functionComparisonExample.js";
import { functionComparisonResultSchema } from "../../../src/domain/functionComparisonSchemas.js";
import { functionDossierSchema } from "../../../src/domain/native/functionDossier.js";
import type { NativeSymbolMetadata } from "../../../src/domain/native/nativeSymbol.js";
import { createEvidence, parseEvidence } from "../../../src/domain/evidence.js";
import { procedureInfoSchema } from "../../../src/domain/native/procedureInfo.js";
import {
  createEvidenceBundle,
  parseEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import { nativeFunctionMatchingSchema } from "../../../src/domain/native/functionMatching.js";

const createMatchingFixture = async () => {
  const root = await createTestTempDirectory("rea-native-matching-");
  const ancestor = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_provenance",
    parameters: {},
    result: { source: "Synthetic ancestor" },
  });
  const unrelated = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_unrelated",
    parameters: {},
    result: { source: "Unselected synthetic record" },
  });
  const dependency = createEvidence(undefined, nativeMatchingProvider, {
    operation: "fixture_dependency",
    parameters: {},
    result: { source: "Synthetic dependency" },
    evidenceLinks: [ancestor.evidence_id],
  });
  const left = nativeMatchingInventory(
    "1",
    [
      { address: "0x10", value: "main" },
      { address: "0x20", value: "old_name" },
    ],
    [dependency.evidence_id],
  );
  const right = nativeMatchingInventory("2", [
    { address: "0x30", value: "main" },
    { address: "0x40", value: "new_name" },
  ]);
  const leftDetails = [
    ...nativeMatchingDetails("1", "0x10", "9000", true),
    ...nativeMatchingDetails("1", "0x20", "c3", true),
  ];
  const rightDetails = [
    ...nativeMatchingDetails("2", "0x30", "9001", true),
    ...nativeMatchingDetails("2", "0x40", "c3", true),
  ];
  const ancestorsPath = join(root, "ancestors.json");
  await writeFile(
    ancestorsPath,
    JSON.stringify(createEvidenceBundle([ancestor, unrelated])),
  );
  const importedPath = join(root, "dependencies.json");
  await writeFile(
    importedPath,
    JSON.stringify(createEvidenceBundle([ancestor, dependency])),
  );
  return {
    root,
    ancestor,
    dependency,
    unrelated,
    left,
    right,
    leftDetails,
    rightDetails,
    ancestorsPath,
    importedPath,
  };
};

cliTest(
  "keeps the committed Evidence receipt when JSON Lines refuses the result",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-matching-jsonl-receipt-");
    const request = join(root, "request.json");
    const left = nativeMatchingInventory("1", [
      { address: "0x10", value: "main" },
    ]);
    const right = nativeMatchingInventory("2", [
      { address: "0x20", value: "main" },
    ]);
    for (const detail of ["summary", "complete"] as const) {
      await writeFile(request, JSON.stringify({ left, right, detail }));
      const output = join(root, `${detail}.json`);
      const result = await cli.run({
        arguments: [
          "match-native-functions",
          request,
          "--evidence_output",
          output,
          "--format",
          "jsonl",
        ],
      });
      expect(result.exitCode).toBe(1);
      const receipt = {
        path: output,
        bytes: (await readFile(output)).byteLength,
      };
      expect(JSON.parse(result.stdout)).toMatchObject({
        type: "error",
        result: {
          code: "invalid_request",
          category: "invalid_input",
          details: { diagnostics: { evidence_bundle: receipt } },
        },
      });
      const retry = await cli.run({
        arguments: [
          "match-native-functions",
          request,
          "--evidence_output",
          output,
          "--json",
        ],
      });
      expect(retry.exitCode).toBe(1);
      expect(retry.json).toMatchObject({ details: { reason: "exists" } });
      expect(
        parseEvidenceBundle(JSON.parse(await readFile(output, "utf8"))).records,
      ).toHaveLength(3);
    }
  },
);
const verifyPortableCli = async (
  cli: TestCli,
  fixture: Awaited<ReturnType<typeof createMatchingFixture>>,
  input: Record<string, unknown>,
  evidenceId: string,
) => {
  const {
    root,
    ancestor,
    dependency,
    unrelated,
    left,
    right,
    leftDetails,
    rightDetails,
    ancestorsPath,
  } = fixture;
  const bundlePath = join(root, "sources.json"),
    inputPath = join(root, "request.json"),
    outputPath = join(root, "result.json");
  await writeFile(
    bundlePath,
    JSON.stringify(
      createEvidenceBundle([
        left,
        right,
        ...leftDetails,
        ...rightDetails,
        dependency,
      ]),
    ),
  );
  const original = await readFile(bundlePath);
  await writeFile(inputPath, JSON.stringify({ ...input, detail: "complete" }));
  const cliFull = await cli.run({
    arguments: [
      "match-native-functions",
      inputPath,
      "--source_bundle",
      ancestorsPath,
      "--source_bundle",
      bundlePath,
      "--json",
    ],
  });
  expect(cliFull.exitCode, cliFull.stderr).toBe(0);
  expect(parseEvidence(cliFull.json).evidence_id).toBe(evidenceId);
  await writeFile(inputPath, JSON.stringify(input));
  const cliSummary = await cli.run({
    arguments: [
      "match-native-functions",
      inputPath,
      "--source_bundle",
      ancestorsPath,
      "--source_bundle",
      bundlePath,
      "--evidence_output",
      outputPath,
      "--json",
    ],
  });
  expect(cliSummary.exitCode, cliSummary.stderr).toBe(0);
  expect(cliSummary.json).toMatchObject({
    summary: {
      normalized_result: { parent_evidence_id: evidenceId },
    },
    evidence_bundle: { path: outputPath },
  });
  const bundle = parseEvidenceBundle(
    JSON.parse(await readFile(outputPath, "utf8")),
  );
  const ids = new Set(bundle.records.map((x) => x.evidence_id));
  for (const record of bundle.records)
    for (const id of record.evidence_links)
      expect(
        ids.has(id),
        `Missing dependency ${id} of ${record.evidence_id}`,
      ).toBe(true);
  expect(ids.has(ancestor.evidence_id)).toBe(true);
  expect(ids.has(dependency.evidence_id)).toBe(true);
  expect(ids.has(unrelated.evidence_id)).toBe(false);
  expect(ids.has(evidenceId)).toBe(true);
  expect(Buffer.compare(await readFile(bundlePath), original)).toBe(0);
  const incomplete = await cli.run({
    arguments: [
      "match-native-functions",
      inputPath,
      "--source_bundle",
      bundlePath,
      "--evidence_output",
      join(root, "incomplete.json"),
      "--json",
    ],
  });
  expect(incomplete.json).toMatchObject({
    code: "evidence_integrity_mismatch",
  });
};

cliTest.for([{ profile: "full" }, { profile: "compact" }] as const)(
  "shared public CLI/MCP matching retains sources, pages exact facts, and feeds selected dossier pairs directly to compare_functions ($profile)",
  { timeout: 60000 },
  async ({ profile }, { cli }) => {
    const fixture = await createMatchingFixture();
    const { left, right, leftDetails, rightDetails, importedPath } = fixture;
    const { call } = await connectLocalToolsMcp({
      REA_MCP_INPUT_SCHEMA_PROFILE: profile,
    });
    const imported = await call("import_evidence_bundle", {
      path: importedPath,
    });
    expect(imported.isError, JSON.stringify(imported)).not.toBe(true);
    const full = await call("match_native_functions", {
      left,
      right,
      left_observations: leftDetails,
      right_observations: rightDetails,
      detail: "complete",
    });
    expect(full.isError, JSON.stringify(full)).not.toBe(true);
    const evidence = parseEvidence(full.structuredContent),
      report = nativeFunctionMatchingSchema.parse(evidence.normalized_result);
    expect(report.summary).toEqual({
      matched: 2,
      only_left: 0,
      only_right: 0,
      unresolved: 0,
    });
    const reference = (evidence_id: string) => ({
      kind: "retained-evidence",
      evidence_id,
    });
    const input = {
      left: reference(left.evidence_id),
      right: reference(right.evidence_id),
      left_observations: leftDetails.map((x) => reference(x.evidence_id)),
      right_observations: rightDetails.map((x) => reference(x.evidence_id)),
    };
    const summary = await call("match_native_functions", input);
    expect(summary.isError, JSON.stringify(summary)).not.toBe(true);
    expect(
      parseEvidence(summary.structuredContent).normalized_result,
    ).toMatchObject({
      kind: "summary",
      artifact: null,
      parent_evidence_id: evidence.evidence_id,
      summary: { summary: report.summary },
    });
    expect(parseEvidence(summary.structuredContent).locations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "artifact-path" }),
      ]),
    );
    const page = await call("inspect_analysis_view", {
      source: reference(evidence.evidence_id),
      view: {
        kind: "function-matches",
        collection: "functions",
        sides: ["left"],
        fields: ["name", "body_sha256"],
        offset: 1,
        limit: 1,
      },
    });
    expect(page.isError, JSON.stringify(page)).not.toBe(true);
    expect(
      parseEvidence(page.structuredContent).normalized_result,
    ).toMatchObject({
      artifact: null,
      coverage: { total: 2, next_offset: null },
      items: [
        {
          name: "old_name",
          function_id: `${left.evidence_id}/1`,
          address: "0x20",
        },
      ],
    });
    expect(parseEvidence(page.structuredContent).locations).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "artifact-path" }),
      ]),
    );
    const compared = await call(
      "compare_functions",
      report.matches[0]!.compare_functions_input!,
    );
    expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
    expect(parseEvidence(compared.structuredContent).operation).toBe(
      "compare_functions",
    );
    await verifyPortableCli(cli, fixture, input, evidence.evidence_id);
    const missing = await call("match_native_functions", {
      left: reference(`ev_${"a".repeat(64)}`),
      right: reference(right.evidence_id),
    });
    expect(missing.isError).toBe(true);
  },
);

const roleLabelDossier = (
  side: "1" | "2",
  address: string,
  label: NativeSymbolMetadata["loader_role_label"],
) => {
  const value = functionDossierSchema.parse(
    FUNCTION_COMPARISON_EXAMPLE.left.normalized_result,
  );
  value.procedure = {
    address,
    name: "entry",
    symbol: {
      primary: true,
      dynamic: false,
      external: false,
      type: "function",
      source: "imported",
      ...(label === undefined ? {} : { loader_role_label: label }),
    },
    classification: null,
    body: nativeMatchingBody(address, 1),
    signature: null,
    locals: [],
  };
  value.basic_blocks = [];
  return createEvidence(nativeMatchingTarget(side), nativeMatchingProvider, {
    operation: "analyze_function",
    parameters: { procedure: address },
    result: value,
    relationshipCoverage: { status: "complete" },
  });
};

cliTest(
  "native matching and comparison keep loader-synthesized role labels apart from exact symbols through CLI and MCP",
  { timeout: 60000 },
  async ({ cli }) => {
    // Unrelated entry bodies, equal synthesized initializer bodies, an
    // artifact-supplied role name, and a role name whose origin is unknown.
    const left = nativeMatchingInventory("1", [
      { address: "0x10", value: "entry", loader_role_label: "synthesized" },
      { address: "0x20", value: "_DT_INIT", loader_role_label: "synthesized" },
      {
        address: "0x30",
        value: "_INIT_0",
        loader_role_label: "artifact-symbol",
      },
      { address: "0x40", value: "_FINI_0", loader_role_label: "unexamined" },
    ]);
    const right = nativeMatchingInventory("2", [
      { address: "0x50", value: "entry", loader_role_label: "synthesized" },
      { address: "0x60", value: "_DT_INIT", loader_role_label: "synthesized" },
      {
        address: "0x70",
        value: "_INIT_0",
        loader_role_label: "artifact-symbol",
      },
      { address: "0x80", value: "_FINI_0", loader_role_label: "unexamined" },
    ]);
    const leftObservations = [
      ...nativeMatchingDetails("1", "0x10", "e8000000c3"),
      ...nativeMatchingDetails("1", "0x20", "4883ec08c3"),
    ];
    const rightObservations = [
      ...nativeMatchingDetails("2", "0x50", "b82a000000c3"),
      ...nativeMatchingDetails("2", "0x60", "4883ec08c3"),
    ];
    const request = {
      left,
      right,
      left_observations: leftObservations,
      right_observations: rightObservations,
      detail: "complete",
    };
    const { call } = await connectLocalToolsMcp();
    const mcp = await call("match_native_functions", request);
    expect(mcp.isError, JSON.stringify(mcp)).not.toBe(true);
    const evidence = parseEvidence(mcp.structuredContent);
    const report = nativeFunctionMatchingSchema.parse(
      evidence.normalized_result,
    );
    const outcome = (name: string) =>
      report.matches
        .filter((match) =>
          [...match.left, ...match.right].some(
            (member) => member.name === name,
          ),
        )
        .map(({ state, basis }) => ({ state, basis }));
    expect(outcome("entry")).toEqual([
      { state: "only_left", basis: null },
      { state: "only_right", basis: null },
    ]);
    expect(outcome("_DT_INIT")).toEqual([
      { state: "matched", basis: "identical-bytes" },
    ]);
    expect(outcome("_INIT_0")).toEqual([
      { state: "matched", basis: "exact-symbol" },
    ]);
    expect(outcome("_FINI_0")).toEqual([
      { state: "only_left", basis: null },
      { state: "only_right", basis: null },
    ]);
    const members = report.matches.flatMap((match) => [
      ...match.left,
      ...match.right,
    ]);
    for (const member of members)
      expect(
        member.limitations.includes(
          "Provider loader-synthesized role label; exact-name matching is unavailable. Independent complete body bytes remain eligible.",
        ),
        member.name,
      ).toBe(member.name === "entry" || member.name === "_DT_INIT");
    expect(
      members
        .filter((member) => member.name === "_FINI_0")
        .every((member) =>
          member.limitations.includes(
            "Symbol origin unavailable; exact-name matching is unavailable. Independent complete body bytes remain eligible.",
          ),
        ),
    ).toBe(true);

    // The CLI shares the matching implementation and Evidence identity.
    const root = await createTestTempDirectory("rea-matching-role-labels-");
    const requestPath = join(root, "request.json");
    await writeFile(requestPath, JSON.stringify(request));
    const cliResult = await cli.run({
      arguments: ["match-native-functions", requestPath, "--json"],
    });
    expect(cliResult.exitCode, cliResult.stderr).toBe(0);
    expect(parseEvidence(cliResult.json).evidence_id).toBe(
      evidence.evidence_id,
    );

    // compare_functions (MCP-only) consumes the same symbol-origin owner.
    for (const label of ["synthesized", "artifact-symbol"] as const) {
      const compared = await call("compare_functions", {
        left: roleLabelDossier("1", "0x10", label),
        right: roleLabelDossier("2", "0x50", label),
      });
      expect(compared.isError, JSON.stringify(compared)).not.toBe(true);
      expect(
        functionComparisonResultSchema.parse(
          parseEvidence(compared.structuredContent).normalized_result,
        ).function_match,
      ).toMatchObject(
        label === "synthesized"
          ? { status: "ambiguous", method: "explicit" }
          : { status: "matched", method: "symbol" },
      );
    }
  },
);

cliTest(
  "native matching rejects corrupt and misselected MCP sources without retaining them",
  async () => {
    const fixture = await createMatchingFixture();
    const { left, right, leftDetails, root, importedPath } = fixture;
    const { call } = await connectLocalToolsMcp();
    const importedSources = await call("import_evidence_bundle", {
      path: importedPath,
    });
    expect(importedSources.isError, JSON.stringify(importedSources)).not.toBe(
      true,
    );
    const before = await call("get_evidence_bundle", {});
    const corruptEnvelope = { ...left, normalized_result: [] };
    const badCoordinate = nativeMatchingInventory("1", [
      { address: "not-an-address", value: "main" },
    ]);
    const observationResult = procedureInfoSchema.parse(
      nativeMatchingDetails("1", "0x10", "c3")[0]!.normalized_result,
    );
    const corruptObservation = createEvidence(
      nativeMatchingTarget("1"),
      nativeMatchingProvider,
      {
        operation: "procedure_info",
        parameters: { procedure: "0x10" },
        result: {
          ...observationResult,
          entrypoint: "not-an-address",
        },
      },
    );
    for (const { request, expected } of [
      {
        request: { left: corruptEnvelope, right },
        expected: { code: "evidence_integrity_mismatch" },
      },
      {
        request: { left: badCoordinate, right },
        expected: { code: "evidence_integrity_mismatch" },
      },
      {
        request: { left, right, left_observations: [corruptObservation] },
        expected: { code: "evidence_integrity_mismatch" },
      },
      {
        request: { left: leftDetails[0], right },
        expected: {
          code: "invalid_request",
          details: {
            issues: [expect.objectContaining({ path: ["left"] })],
          },
        },
      },
    ]) {
      const rejected = await call("match_native_functions", {
        ...request,
        detail: "complete",
      });
      expect(parseMcpToolError(rejected).error).toMatchObject(expected);
      expect((await call("get_evidence_bundle", {})).structuredContent).toEqual(
        before.structuredContent,
      );
    }

    const corruptBundlePath = join(root, "corrupt-source.json");
    await writeFile(
      corruptBundlePath,
      JSON.stringify(createEvidenceBundle([badCoordinate, right])),
    );
    const importedCorruptPayload = await call("import_evidence_bundle", {
      path: corruptBundlePath,
    });
    expect(
      importedCorruptPayload.isError,
      JSON.stringify(importedCorruptPayload),
    ).not.toBe(true);
    const retainedBefore = await call("get_evidence_bundle", {});
    const retainedFailure = await call("match_native_functions", {
      left: {
        kind: "retained-evidence",
        evidence_id: badCoordinate.evidence_id,
      },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
      detail: "complete",
    });
    expect(parseMcpToolError(retainedFailure).error).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: {
        reason: expect.stringContaining("Evidence validation failed"),
      },
    });
    expect((await call("get_evidence_bundle", {})).structuredContent).toEqual(
      retainedBefore.structuredContent,
    );

    const malformedOuterRequest = await call("match_native_functions", {
      right,
      detail: "complete",
    });
    expect(parseMcpToolError(malformedOuterRequest).error.code).toBe(
      "invalid_request",
    );
    expect((await call("get_evidence_bundle", {})).structuredContent).toEqual(
      retainedBefore.structuredContent,
    );
  },
  60000,
);

cliTest(
  "native matching retains malformed inline field paths through MCP and CLI source admission",
  async ({ cli }) => {
    const left = nativeMatchingInventory("1", [
      { address: "0x10", value: "main" },
    ]);
    const right = nativeMatchingInventory("2", [
      { address: "0x20", value: "main" },
    ]);
    const root = await createTestTempDirectory("rea-matching-input-");
    const bundlePath = join(root, "sources.json");
    await writeFile(
      bundlePath,
      JSON.stringify(createEvidenceBundle([left, right])),
    );
    const { call } = await connectLocalToolsMcp();
    for (const field of [
      "left",
      "right",
      "left_observations",
      "right_observations",
    ] as const) {
      const observation = field.endsWith("observations");
      const request = {
        left,
        right,
        detail: "complete",
        [field]: observation ? ["not-evidence"] : "not-evidence",
      };
      const expected = {
        code: "invalid_request",
        details: {
          issues: [
            expect.objectContaining({
              path: observation ? [field, 0] : [field],
              reason: "invalid_type",
            }),
          ],
        },
      };
      expect(
        parseMcpToolError(await call("match_native_functions", request)).error,
      ).toMatchObject(expected);
      const requestPath = join(root, "request.json");
      await writeFile(requestPath, JSON.stringify(request));
      for (const sourceArguments of [[], ["--source_bundle", bundlePath]]) {
        const rejected = await cli.run({
          arguments: [
            "match-native-functions",
            requestPath,
            ...sourceArguments,
            "--json",
          ],
        });
        expect(rejected.exitCode).not.toBe(0);
        expect(rejected.json).toMatchObject(expected);
      }
    }
    const corrected = await call("match_native_functions", {
      left,
      right,
      detail: "complete",
    });
    expect(corrected.isError).not.toBe(true);
    expect(
      parseEvidence(corrected.structuredContent).normalized_result,
    ).toMatchObject({ summary: { matched: 1 } });
  },
);

cliTest(
  "native matching CLI inline and portable sources report the same validation errors",
  async ({ cli }) => {
    const fixture = await createMatchingFixture();
    const { left, right, leftDetails, root } = fixture;
    const badCoordinate = nativeMatchingInventory("1", [
      { address: "not-an-address", value: "main" },
    ]);
    const corruptBundlePath = join(root, "corrupt-source.json");
    await writeFile(
      corruptBundlePath,
      JSON.stringify(createEvidenceBundle([badCoordinate, right])),
    );
    const requestPath = join(root, "wrong-role-request.json");
    const portablePath = join(root, "wrong-role-sources.json");
    const wrongRole = leftDetails[0]!;
    const inlineRequest = { left: wrongRole, right, detail: "complete" };
    const portableRequest = {
      left: { kind: "retained-evidence", evidence_id: wrongRole.evidence_id },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
      detail: "complete",
    };
    await writeFile(requestPath, JSON.stringify(inlineRequest));
    const inline = await cli.run({
      arguments: ["match-native-functions", requestPath, "--json"],
    });
    await writeFile(
      portablePath,
      JSON.stringify(createEvidenceBundle([wrongRole, right])),
    );
    await writeFile(requestPath, JSON.stringify(portableRequest));
    const portable = await cli.run({
      arguments: [
        "match-native-functions",
        requestPath,
        "--source_bundle",
        portablePath,
        "--json",
      ],
    });
    expect(inline.exitCode).not.toBe(0);
    expect(portable.exitCode).toBe(inline.exitCode);
    const wrongRoleError = {
      code: "invalid_request",
      details: {
        issues: [expect.objectContaining({ path: ["left"] })],
      },
    };
    expect(inline.json).toMatchObject(wrongRoleError);
    expect(portable.json).toMatchObject(wrongRoleError);

    const corruptRequest = { left: badCoordinate, right, detail: "complete" };
    await writeFile(requestPath, JSON.stringify(corruptRequest));
    const corruptInline = await cli.run({
      arguments: ["match-native-functions", requestPath, "--json"],
    });
    const corruptPortableRequest = {
      left: {
        kind: "retained-evidence",
        evidence_id: badCoordinate.evidence_id,
      },
      right: { kind: "retained-evidence", evidence_id: right.evidence_id },
      detail: "complete",
    };
    await writeFile(requestPath, JSON.stringify(corruptPortableRequest));
    const corruptPortable = await cli.run({
      arguments: [
        "match-native-functions",
        requestPath,
        "--source_bundle",
        corruptBundlePath,
        "--json",
      ],
    });
    expect(corruptInline.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
    expect(corruptPortable.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });

    const malformedBundlePath = join(root, "malformed-outer-frame.json");
    await writeFile(malformedBundlePath, JSON.stringify({ records: [left] }));
    const malformedBundle = await cli.run({
      arguments: [
        "match-native-functions",
        requestPath,
        "--source_bundle",
        malformedBundlePath,
        "--json",
      ],
    });
    expect(malformedBundle.exitCode).not.toBe(0);
    expect(malformedBundle.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });
  },
  60000,
);

cliTest(
  "native matching admits the request representation before authenticating observation carriers",
  async () => {
    // Reach the native matching representation boundary with this intentionally
    // oversized carrier fixture, rather than stopping at MCP's lower default.
    const { call } = await connectLocalToolsMcp({
      REA_MCP_MAX_INPUT_ELEMENTS: "1048576",
    });
    const left = nativeMatchingInventory("1", [
      { address: "0x10", value: "main" },
    ]);
    const right = nativeMatchingInventory("2", [
      { address: "0x20", value: "main" },
    ]);
    const before = await call("get_evidence_bundle", {});
    const observations = Array.from({ length: 524288 }, () => ({}));
    const response = await call("match_native_functions", {
      left,
      right,
      left_observations: observations,
      detail: "complete",
    });
    expect(parseMcpToolError(response).error).toMatchObject({
      code: "resource_constraint",
      details: {
        operation: "match_native_functions",
        resource: "capacity",
      },
    });
    expect((await call("get_evidence_bundle", {})).structuredContent).toEqual(
      before.structuredContent,
    );
  },
  60000,
);
