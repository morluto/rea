import { unknownTarget } from "../../../src/domain/targetIdentity.js";
import { parseMcpToolError } from "../../fixtures/mcpToolError.js";
import { RECREATE_EVIDENCE_GUIDANCE } from "../../../src/domain/evidenceFormat.js";
import { PRE_66_NULL_COVERAGE_EVIDENCE } from "../../../src/domain/evidenceLegacy.fixture.js";
import {
  access,
  lstat,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";

import { expect } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import { z } from "zod";

import { jsonValueSchema } from "../../../src/domain/jsonValue.js";
import { createEvidence } from "../../../src/domain/evidence.js";
import {
  createEvidenceBundle,
  serializeEvidenceBundle,
} from "../../../src/domain/evidenceBundle.js";
import {
  createResidualUnknown,
  updateResidualUnknown,
} from "../../../src/domain/residualUnknown.js";
import { createBrowserEvidence } from "../../../src/application/BrowserEvidence.js";
import { inspectWebPageInputSchema } from "../../../src/domain/browserObservation.js";
import { passiveNetworkCapture } from "../../fixtures/passiveNetworkCapture.js";
import { createTestTempDirectory } from "../../fixtures/temporaryDirectory.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const revisionBundle = () => {
  const records = ["open", "investigate"].map((operation) =>
    createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      { operation, parameters: {}, result: { observed: operation } },
    ),
  );
  const [opened, investigated] = records;
  if (opened === undefined || investigated === undefined)
    throw new Error("Missing mutation Evidence");
  const details = {
    severity: "high" as const,
    supporting_evidence_ids: [],
    contradicting_evidence_ids: [],
    required_authority: null,
    required_confidence: "observed" as const,
    required_environment: null,
    recommended_probes: [],
    relationships: [],
  };
  const initial = createResidualUnknown(
    { question: "How is this input handled?", domain: "protocol", ...details },
    opened.evidence_id,
    null,
  );
  const revised = updateResidualUnknown(
    initial,
    {
      unknown_id: initial.unknown_id,
      expected_revision: initial.revision,
      status: "investigating",
      ...details,
      resolution: null,
    },
    investigated.evidence_id,
  );
  return createEvidenceBundle(records, [initial, revised]);
};

cliTest(
  "rejects empty Evidence path arguments before filesystem selection",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-empty-evidence-path-");
    const encoded = JSON.stringify(revisionBundle());
    await writeFile(join(root, "bundle.json"), encoded);
    for (const [args, field, missing] of [
      [["evidence-import", ""], "path", false],
      [["evidence-export", "", "refused.json"], "source", false],
      [["evidence-export", "bundle.json", ""], "output", false],
      [["evidence-pack", "", "bundle.json"], "output", false],
      [["evidence-pack", "packed.json"], "sources", true],
      [["evidence-pack", "packed.json", ""], "sources.0", false],
      [["evidence-pack", "packed.json", "bundle.json", ""], "sources.1", false],
      [["compare", "", "bundle.json"], "left", false],
      [["compare", "bundle.json", ""], "right", false],
      [["evidence-export", "missing.json", ""], "output", false],
    ] as const) {
      const result = await cli.run({
        arguments: [...args, "--json"],
        cwd: root,
      });
      expect(result.exitCode, JSON.stringify(args)).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.json).toMatchObject({
        code: "VALIDATION_ERROR",
        fieldErrors: [
          {
            path: field,
            code: missing ? "invalid_type" : "too_small",
            missing,
          },
        ],
      });
      expect(result.json).not.toHaveProperty("details.path");
    }
    expect(await readdir(root)).toEqual(["bundle.json"]);
    expect(await readFile(join(root, "bundle.json"), "utf8")).toBe(encoded);
  },
);

cliTest(
  "exports canonical Evidence to the exact selected filename with accurate receipts and overwrite",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-spaced-path-");
    const source = " bundle name.json";
    const output = " exported bundle.json";
    const outputPath = join(root, output);
    const history = revisionBundle();
    const extra = createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "observe", parameters: {}, result: { observed: true } },
    );
    const bundle = createEvidenceBundle(
      [...history.records, extra],
      history.unknowns,
    );
    const encoded = JSON.stringify(bundle, null, 2);
    await writeFile(join(root, source), encoded);
    const imported = await cli.run({
      arguments: ["evidence-import", source, "--json"],
      cwd: root,
    });
    expect(imported.exitCode, imported.stderr).toBe(0);
    expect(imported.json).toEqual({ imported: 3, unknowns_added: 2, total: 3 });

    const args = ["evidence-export", source, output, "--json"];
    const exported = await cli.run({ arguments: args, cwd: root });
    expect(exported.exitCode, exported.stderr).toBe(0);
    const bytes = await readFile(outputPath);
    const receipt = {
      path: outputPath,
      bytes: bytes.length,
      records: 3,
      unknowns: 2,
    };
    expect(exported.json).toMatchObject(receipt);
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(bundle);

    const digest = createHash("sha256").update(bytes).digest("hex");
    const compared = await cli.run({
      arguments: ["compare", source, output, "--json"],
      cwd: root,
    });
    expect(compared.exitCode, compared.stderr).toBe(0);
    expect(compared.json).toMatchObject({
      status: "unchanged",
      left_bundle_sha256: digest,
      right_bundle_sha256: digest,
    });

    const previous = "previous output\n";
    await writeFile(outputPath, previous);
    const collision = await cli.run({ arguments: args, cwd: root });
    expect(collision.exitCode).toBe(1);
    expect(collision.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "write", reason: "exists", path: outputPath },
      message: expect.stringContaining("allow overwrite"),
    });
    expect(await readFile(outputPath, "utf8")).toBe(previous);

    const replaced = await cli.run({
      arguments: [...args, "--full-output", "--overwrite"],
      cwd: root,
    });
    expect(replaced.exitCode, replaced.stderr).toBe(0);
    expect(replaced.json).toMatchObject({ data: receipt });
    expect((await readFile(outputPath)).equals(bytes)).toBe(true);
    expect(await readFile(join(root, source), "utf8")).toBe(encoded);
    expect((await readdir(root)).sort()).toEqual([source, output].sort());
  },
);

cliTest(
  "advertises the same nonempty path constraints to schema clients",
  async ({ cli }) => {
    const ajv = new Ajv2020({ strict: false, validateFormats: false });
    for (const [command, valid] of [
      ["evidence-import", { path: " bundle.json" }],
      ["evidence-export", { source: " bundle.json", output: " exported.json" }],
      ["compare", { left: " bundle.json", right: " other.json" }],
    ] as const) {
      const result = await cli.run({
        arguments: [command, "--schema", "--json"],
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(result.stderr).toBe("");
      const { args } = z
        .object({ args: z.record(z.string(), z.unknown()) })
        .parse(result.json);
      expect(ajv.validateSchema(args), ajv.errorsText()).toBe(true);
      const validate = ajv.compile(args);
      expect(validate(valid), command).toBe(true);
      for (const field of Object.keys(valid))
        expect(validate({ ...valid, [field]: "" }), `${command}.${field}`).toBe(
          false,
        );
    }

    const packSchema = await cli.run({
      arguments: ["evidence-pack", "--schema", "--json"],
    });
    expect(packSchema.exitCode, packSchema.stderr).toBe(0);
    const { args: packArgs } = z
      .object({ args: z.record(z.string(), z.unknown()) })
      .parse(packSchema.json);
    expect(ajv.validateSchema(packArgs), ajv.errorsText()).toBe(true);
    const validatePack = ajv.compile(packArgs);
    expect(
      validatePack({ output: " bundle.json", sources: [" record.json"] }),
    ).toBe(true);
    expect(validatePack({ output: "", sources: ["record.json"] })).toBe(false);
    expect(validatePack({ output: "bundle.json", sources: [] })).toBe(false);
    expect(validatePack({ output: "bundle.json", sources: [""] })).toBe(false);
  },
);

cliTest(
  "rejects directory exports with file-path recovery in both overwrite modes",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-export-directory-cli-");
    const source = join(root, "bundle.json");
    const output = join(root, "output");
    const sentinel = join(output, "keep.txt");
    const emptyBundle = createEvidenceBundle([]);
    const sourceBytes = JSON.stringify(emptyBundle);
    await writeFile(source, sourceBytes);
    await mkdir(output);
    await writeFile(sentinel, "keep\n");

    for (const flags of [[], ["--overwrite"]]) {
      const result = await cli.run({
        arguments: ["evidence-export", source, output, ...flags, "--json"],
        environment: { REA_LOG_LEVEL: "silent" },
      });
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("");
      expect(result.json).toMatchObject({
        code: "invalid_request",
        category: "invalid_input",
        details: { operation: "write", reason: "not-file", path: output },
        message: expect.stringContaining("regular file"),
        remediation: { action: expect.stringContaining("regular file") },
      });
      expect((await lstat(output)).isDirectory()).toBe(true);
      expect(await readdir(output)).toEqual(["keep.txt"]);
      expect(await readFile(sentinel, "utf8")).toBe("keep\n");
      expect((await readdir(root)).sort()).toEqual(["bundle.json", "output"]);
    }

    const file = join(root, "fresh.json");
    const fresh = await cli.run({
      arguments: ["evidence-export", source, file, "--json"],
    });
    expect(fresh.exitCode, fresh.stderr).toBe(0);
    const bytes = await readFile(file);
    expect(fresh.json).toMatchObject({
      path: file,
      bytes: bytes.length,
      records: 0,
      unknowns: 0,
    });
    expect(JSON.parse(bytes.toString("utf8"))).toEqual(emptyBundle);
    expect(await readFile(source, "utf8")).toBe(sourceBytes);
    expect((await readdir(root)).sort()).toEqual([
      "bundle.json",
      "fresh.json",
      "output",
    ]);
  },
);

cliTest(
  "refuses BOM-prefixed bundle export with the JSON format recovery",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-bundle-bom-cli-");
    const path = join(root, "bundle.json");
    const output = join(root, "exported.json");
    const bom = `\uFEFF${JSON.stringify(revisionBundle())}`;
    await writeFile(path, bom);
    const result = await cli.run({
      arguments: ["evidence-export", path, output, "--json"],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(result.exitCode).toBe(1);
    expect(result.json).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: {
        path,
        reason: "invalid-json",
        content_issues: [{ reason: "invalid_format" }],
      },
      remediation: {
        action: expect.stringMatching(
          /byte-order mark.*UTF-8 without a byte-order mark/iu,
        ),
      },
    });
    expect(await readFile(path, "utf8")).toBe(bom);
    await expect(access(output)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

cliTest.for([
  "export_evidence_bundle",
  "pack_evidence_bundle",
  "compare_bundles",
  "get_evidence_bundle",
])("attributes an early heap refusal to $0", async (operation, { cli }) => {
  const root = await createTestTempDirectory("rea-bundle-operation-");
  const path = join(root, "parent.json");
  const output = join(root, "output.json");
  const bundle = revisionBundle();
  await writeFile(
    path,
    JSON.stringify(
      operation === "pack_evidence_bundle" ? bundle.records[0] : bundle,
    ),
  );
  const preload =
    "import v8 from 'node:v8';import {syncBuiltinESMExports} from 'node:module';const read=v8.getHeapStatistics;v8.getHeapStatistics=()=>({...read(),total_available_size:0});syncBuiltinESMExports();";
  const arguments_ =
    operation === "export_evidence_bundle"
      ? ["evidence-export", path, output]
      : operation === "pack_evidence_bundle"
        ? ["evidence-pack", output, path]
        : operation === "compare_bundles"
          ? ["compare", path, path]
          : ["inspect-evidence-bundle", JSON.stringify({ path })];
  const result = await cli.run({
    arguments: [...arguments_, "--json"],
    environment: {
      REA_LOG_LEVEL: "silent",
      NODE_OPTIONS: `--max-old-space-size=2048 --import=data:text/javascript;base64,${Buffer.from(preload).toString("base64")}`,
    },
  });
  expect(result.exitCode).toBe(1);
  expect(result.json).toMatchObject({
    code: "resource_constraint",
    details: { operation },
  });
  expect(await readdir(root)).toEqual(["parent.json"]);
});

cliTest(
  "distinguishes wrong-kind input, altered Evidence and incomplete Unknown history",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-import-invalid-");
    const path = join(root, "bundle.json");
    const bundle = revisionBundle();
    const [record, ...otherRecords] = bundle.records;
    const firstUnknown = bundle.unknowns[0];
    if (record === undefined || firstUnknown === undefined)
      throw new Error("Fixture needs one Evidence record and Unknown history");
    for (const [input, failure] of [
      [
        record,
        {
          code: "invalid_request",
          category: "invalid_input",
          details: {
            path,
            operation: "read",
            reason: "wrong-kind",
            detected_kind: "evidence-record",
          },
        },
      ],
      [
        {
          ...bundle,
          records: [
            { ...record, normalized_result: "altered" },
            ...otherRecords,
          ],
        },
        {
          code: "evidence_integrity_mismatch",
          message: expect.stringContaining("records.0.evidence_id"),
        },
      ],
      [
        { ...bundle, unknowns: bundle.unknowns.slice(1) },
        {
          code: "evidence_integrity_mismatch",
          message: expect.stringContaining(
            `${firstUnknown.unknown_id} revision history has a gap`,
          ),
        },
      ],
    ] as const) {
      await writeFile(path, JSON.stringify(input));
      const result = await cli.run({
        arguments: ["evidence-import", path, "--json"],
      });
      expect(result.exitCode).toBe(1);
      expect(result.json).toMatchObject(failure);
      expect(result.json).not.toHaveProperty("imported");
    }
  },
);

cliTest(
  "preserves a selected own __proto__ member from complete bundle data",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-filter-proto-");
    const path = join(root, "bundle.json");
    const result = jsonValueSchema.parse(
      JSON.parse('{"__proto__":{"answer":7},"normal":{"answer":7}}'),
    );
    const record = createEvidence(
      unknownTarget("not-observed"),
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "ordinary-json", parameters: {}, result },
    );
    await writeFile(path, JSON.stringify(createEvidenceBundle([record])));

    const output = await cli.run({
      arguments: [
        "inspect-evidence-bundle",
        JSON.stringify({ path, detail: "complete" }),
        "--json",
        "--filter-output",
        "records[0,1].normalized_result.__proto__.answer",
      ],
    });

    expect(output.exitCode).toBe(0);
    const records = (
      output.json as {
        records: Array<{ normalized_result: unknown }>;
      }
    ).records;
    expect(Object.keys(records)).toEqual(["0"]);
    const normalizedResult = records[0]?.normalized_result;
    expect(Object.keys(normalizedResult as object)).toEqual(["__proto__"]);
    expect(Object.hasOwn(normalizedResult as object, "__proto__")).toBe(true);
    expect((normalizedResult as Record<string, unknown>)["__proto__"]).toEqual({
      answer: 7,
    });
  },
);

cliTest(
  "refuses an earlier-format record inside a current bundle",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-legacy-coverage-identity-");
    const path = join(root, "legacy.json");
    await writeFile(
      path,
      JSON.stringify({
        ...createEvidenceBundle([]),
        records: [PRE_66_NULL_COVERAGE_EVIDENCE],
      }),
    );
    const refusal = {
      code: "evidence_integrity_mismatch",
      retryable: false,
      message: expect.stringContaining(
        "Evidence record predates format revision",
      ),
    };
    const imported = await cli.run({
      arguments: ["evidence-import", path, "--json"],
    });
    expect(imported.exitCode).toBe(1);
    const call = await cli.sharedMcpCall?.();
    if (call === undefined) throw new Error("Expected shared MCP session");
    const response = await call("import_evidence_bundle", { path });
    expect(response.isError).toBe(true);
    for (const error of [imported.json, parseMcpToolError(response).error]) {
      expect(error).toMatchObject(refusal);
      expect(error).toMatchObject({
        message: expect.stringContaining(RECREATE_EVIDENCE_GUIDANCE),
      });
    }
  },
);

cliTest(
  "packs 1..N standalone Evidence files for downstream bundle workflows and enforces overwrite and conflict checks",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-pack-cli-");
    const appDir = join(root, "app");
    await mkdir(appDir);
    await writeFile(
      join(appDir, "package.json"),
      JSON.stringify({
        name: "packed-fixture",
        type: "module",
        main: "main.mjs",
      }),
    );
    await writeFile(
      join(appDir, "main.mjs"),
      'export const greet = () => "hello";\n',
    );

    const staticAnalysis = await cli.run({
      arguments: [
        "analyze-javascript-application",
        appDir,
        "--artifact-format",
        "directory",
        "--json",
      ],
    });
    expect(staticAnalysis.exitCode, staticAnalysis.stderr).toBe(0);
    const staticRecord = jsonValueSchema.parse(staticAnalysis.json);

    const inspection = passiveNetworkCapture([]);
    const origin = inspection.target.origin;
    inspection.frames = [
      { frame_id: "frame-main", parent_frame_id: null, url: origin, origin },
    ];
    inspection.scripts = {
      total: 1,
      items: [
        {
          script_key: `scr_${"0".repeat(64)}`,
          frame_id: "frame-main",
          url: `${origin}/assets/main.mjs`,
          origin,
          cdp_hash: null,
          length: null,
          is_module: true,
          language: "JavaScript",
          source_map_url: null,
          resource_reconciliation: {
            status: "unmatched",
            reason: "no_exact_sanitized_url",
          },
          source: { included: false, reason: "not-requested" },
        },
      ],
    };
    const runtimeRecord = createBrowserEvidence(
      "inspect_web_page",
      inspectWebPageInputSchema.parse({
        cdp_endpoint: "http://127.0.0.1:9222",
        target_id: "page",
        allowed_origins: [origin],
        observation_ms: 0,
        include_script_sources: false,
      }),
      { source: jsonValueSchema.parse(inspection), facts: inspection },
      {
        id: "rea-cdp-browser",
        name: "REA Chrome DevTools Protocol observation provider",
        version: "2",
      },
    );

    const staticName = " static record.json";
    const runtimeName = " runtime record.json";
    const packedName = " packed bundle.json";
    const packedPath = join(root, packedName);
    const canonicalPath = join(root, "canonical.json");

    await writeFile(
      join(root, staticName),
      JSON.stringify(staticRecord, null, 2),
    );
    await writeFile(join(root, runtimeName), JSON.stringify(runtimeRecord));

    const packed = await cli.run({
      arguments: [
        "evidence-pack",
        packedName,
        staticName,
        runtimeName,
        staticName,
        "--json",
      ],
      cwd: root,
    });
    expect(packed.exitCode, packed.stderr).toBe(0);
    const packedBytes = await readFile(packedPath);
    const expectedReceipt = {
      path: packedPath,
      bytes: packedBytes.length,
      records: 2,
      unknowns: 0,
    };
    expect(packed.json).toEqual(expectedReceipt);

    // Canonical bundle works directly with evidence-export and compare.
    const exported = await cli.run({
      arguments: ["evidence-export", packedPath, canonicalPath, "--json"],
    });
    expect(exported.exitCode, exported.stderr).toBe(0);
    expect((await readFile(canonicalPath)).equals(packedBytes)).toBe(true);
    const compared = await cli.run({
      arguments: ["compare", packedPath, canonicalPath, "--json"],
    });
    expect(compared.exitCode, compared.stderr).toBe(0);
    expect(compared.json).toMatchObject({ status: "unchanged" });

    // Packed bundle works with build-reconstruction-obligation-ledger.
    const ledgerInput = join(root, "ledger.json");
    await writeFile(
      ledgerInput,
      JSON.stringify({
        evidence_bundle: JSON.parse(packedBytes.toString("utf8")),
        reviewed_obligations: [],
        manifest: { bindings: [], contradictions: [] },
      }),
    );
    const ledger = await cli.run({
      arguments: [
        "build-reconstruction-obligation-ledger",
        ledgerInput,
        "--json",
      ],
    });
    expect(ledger.exitCode, ledger.stderr).toBe(0);

    // Packed bundle works with reconcile-javascript-runtime via --evidence-bundle.
    const reconcileInput = join(root, "reconcile.json");
    const staticId = (staticRecord as { evidence_id: string }).evidence_id;
    await writeFile(
      reconcileInput,
      JSON.stringify({
        static_layers: [
          {
            role: "application",
            analysis: { kind: "retained-evidence", evidence_id: staticId },
            runtime_mappings: [
              {
                kind: "url-prefix",
                prefix: `${origin}/assets/`,
                artifact_prefix: "",
              },
            ],
          },
        ],
        runtime_observations: [
          { kind: "retained-evidence", evidence_id: runtimeRecord.evidence_id },
        ],
      }),
    );
    const reconciled = await cli.run({
      arguments: [
        "reconcile-javascript-runtime",
        reconcileInput,
        "--evidence-bundle",
        packedPath,
        "--json",
      ],
    });
    expect(reconciled.exitCode, reconciled.stderr).toBe(0);

    // Overwrite protection and replacement.
    await writeFile(packedPath, "stale\n");
    const collision = await cli.run({
      arguments: ["evidence-pack", packedName, staticName, "--json"],
      cwd: root,
    });
    expect(collision.exitCode).toBe(1);
    expect(collision.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "write", reason: "exists", path: packedPath },
    });
    expect(await readFile(packedPath, "utf8")).toBe("stale\n");

    const overwritten = await cli.run({
      arguments: [
        "evidence-pack",
        packedName,
        staticName,
        runtimeName,
        "--overwrite",
        "--json",
      ],
      cwd: root,
    });
    expect(overwritten.exitCode, overwritten.stderr).toBe(0);
    expect(overwritten.json).toEqual(expectedReceipt);
    expect((await readFile(packedPath)).equals(packedBytes)).toBe(true);

    // Help mentions variadic sources and --overwrite.
    const help = await cli.run({
      arguments: ["evidence-pack", "--help"],
    });
    expect(help.exitCode).toBe(0);
    expect(help.stdout).toContain(
      "Usage: rea evidence-pack <output> <sources...> [options]",
    );
    expect(help.stdout).toContain("--overwrite");
  },
);

cliTest(
  "refuses invalid, BOM-prefixed, wrong-kind, and conflicting records in evidence-pack",
  async ({ cli }) => {
    const root = await createTestTempDirectory("rea-evidence-pack-errors-");
    const valid = createEvidence(
      {
        path: join(root, "one.bin"),
        sha256: "d".repeat(64),
        format: "raw-binary",
      },
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "observe", parameters: {}, result: { ok: true } },
    );
    const relocated = createEvidence(
      {
        path: join(root, "two.bin"),
        sha256: "d".repeat(64),
        format: "raw-binary",
      },
      { id: "fixture", name: "Fixture", version: "1" },
      { operation: "observe", parameters: {}, result: { ok: true } },
    );
    const validPath = join(root, "valid.json");
    const relocatedPath = join(root, "relocated.json");
    const bundlePath = join(root, "bundle.json");
    const bomPath = join(root, "bom.json");
    const tamperedPath = join(root, "tampered.json");
    const legacyPath = join(root, "legacy.json");
    const outPath = join(root, "out.json");
    const dirOutPath = join(root, "dir-out");
    await mkdir(dirOutPath);

    await Promise.all([
      writeFile(validPath, JSON.stringify(valid)),
      writeFile(relocatedPath, JSON.stringify(relocated)),
      writeFile(
        bundlePath,
        serializeEvidenceBundle(createEvidenceBundle([valid])),
      ),
      writeFile(bomPath, `\uFEFF${JSON.stringify(valid)}`),
      writeFile(
        tamperedPath,
        JSON.stringify({ ...valid, normalized_result: "altered" }),
      ),
      writeFile(legacyPath, JSON.stringify(PRE_66_NULL_COVERAGE_EVIDENCE)),
    ]);

    const conflict = await cli.run({
      arguments: ["evidence-pack", outPath, validPath, relocatedPath, "--json"],
    });
    expect(conflict.exitCode).toBe(1);
    expect(conflict.json).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: {
        diagnostics: {
          evidence_id: valid.evidence_id,
          paths: [validPath, relocatedPath],
        },
      },
    });

    const wrongKindBundle = await cli.run({
      arguments: ["evidence-pack", outPath, bundlePath, "--json"],
    });
    expect(wrongKindBundle.exitCode).toBe(1);
    expect(wrongKindBundle.json).toMatchObject({
      code: "invalid_request",
      details: {
        operation: "read",
        reason: "wrong-kind",
        detected_kind: "evidence-bundle",
        path: bundlePath,
      },
    });

    const bom = await cli.run({
      arguments: ["evidence-pack", outPath, bomPath, "--json"],
    });
    expect(bom.exitCode).toBe(1);
    expect(bom.json).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: { path: bomPath, reason: "invalid-json" },
    });

    const tampered = await cli.run({
      arguments: ["evidence-pack", outPath, tamperedPath, "--json"],
    });
    expect(tampered.exitCode).toBe(1);
    expect(tampered.json).toMatchObject({
      code: "evidence_integrity_mismatch",
    });

    const legacy = await cli.run({
      arguments: ["evidence-pack", outPath, legacyPath, "--json"],
    });
    expect(legacy.exitCode).toBe(1);
    expect(legacy.json).toMatchObject({
      code: "evidence_integrity_mismatch",
      message: expect.stringContaining(RECREATE_EVIDENCE_GUIDANCE),
    });

    const dirOut = await cli.run({
      arguments: [
        "evidence-pack",
        dirOutPath,
        validPath,
        "--overwrite",
        "--json",
      ],
    });
    expect(dirOut.exitCode).toBe(1);
    expect(dirOut.json).toMatchObject({
      code: "invalid_request",
      details: { operation: "write", reason: "not-file", path: dirOutPath },
    });

    const longKey = "k".repeat(80 * 1024);
    const oversizedKeyPath = join(root, "oversized-key-record.json");
    await writeFile(
      oversizedKeyPath,
      JSON.stringify({
        ...valid,
        caller_input_paths: { [longKey]: false },
      }),
    );
    const oversizedKey = await cli.run({
      arguments: ["evidence-pack", outPath, oversizedKeyPath, "--json"],
    });
    expect(oversizedKey.exitCode).toBe(1);
    expect(oversizedKey.json).toMatchObject({
      code: "evidence_integrity_mismatch",
      details: {
        issue_path: ["caller_input_paths"],
        diagnostics: { path: oversizedKeyPath },
      },
    });
    expect(Buffer.byteLength(oversizedKey.stdout, "utf8")).toBeLessThanOrEqual(
      65_536,
    );
    expect(oversizedKey.stdout).not.toContain(longKey);

    await expect(access(outPath)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
