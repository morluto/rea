import { expect, it } from "vitest";
import {
  analyzeJavaScriptStaticSource,
  analyzeParsedJavaScriptStaticSource,
} from "../../../tests/fixtures/javascriptStaticAnalysis.js";
import { analyzeCommonJsStaticFixture } from "../../../tests/fixtures/javascriptCommonJsAnalysis.js";
import {
  javaScriptStaticParseStatus,
  unexaminedJavaScriptStaticCoverage,
} from "./javascriptStaticCoverage.js";
import { aliasSelectionBudgetSource } from "../../../tests/fixtures/javascriptAliasSelectionBudget.js";
import {
  javaScriptRuntimeContext,
  javaScriptProgramStrictness,
  parseJavaScriptSource,
  parseRecoveredJavaScript,
} from "./javascriptSourceParser.js";

it.each(["main.js", ".js", ".mjs", ".cjs", ".JS", ".MJS"])(
  "retains the unknown loader condition without inventing syntax errors for %s",
  (path) => {
    const source = '\uFEFF#!/usr/bin/env node\nimport "./dep.mjs";';
    const application = parseJavaScriptSource(source, path, "unknown");
    expect(application).not.toBeNull();
    const historical = parseRecoveredJavaScript(
      source,
      path,
      {},
      "unknown",
    ).file;
    for (const file of [application!, historical]) {
      expect(file.errors).toEqual([]);
      expect(javaScriptRuntimeContext(file.program)).toBe("unknown");
      expect(javaScriptProgramStrictness(file.program)).toBe("unknown");
      const result = analyzeParsedJavaScriptStaticSource(source, file);
      expect(result.parse_status).toBe("partial");
      expect(result.analysis_coverage).toMatchObject({
        syntax: { status: "complete", error_count: 0 },
        semantics: { unknown_findings: 0, uncertainty: ["conditional-loader"] },
      });
      expect(result.references).toMatchObject([
        {
          kind: "static-import",
          specifier: "./dep.mjs",
          location: {
            start: { line: 2, column: 0 },
            end: { line: 2, column: 19 },
          },
        },
      ]);
      expect(result.limitations).toContainEqual(
        expect.stringContaining("package loader mode is unknown"),
      );
    }
  },
);

it.each(["unknown", "unspecified"] as const)(
  "keeps script grammar and conditional coverage for a BOM/hashbang in a %s package",
  (packageType) => {
    const source =
      '\uFEFF#!/usr/bin/env node\nwith ({}) {} module.exports = require("./dep.cjs");';
    const file = parseJavaScriptSource(source, "main.js", packageType);
    expect(file).not.toBeNull();
    expect(file!.program.sourceType).toBe("script");
    expect(javaScriptRuntimeContext(file!.program)).toBe("unknown");
    expect(file!.errors).toEqual([]);
    const result = analyzeParsedJavaScriptStaticSource(source, file!);
    expect(result.analysis_coverage).toMatchObject({
      syntax: { status: "complete", error_count: 0 },
      semantics: {
        uncertainty: expect.arrayContaining(["conditional-loader"]),
      },
    });
  },
);

it("separates dynamic semantic uncertainty from completed syntax and examination", () => {
  const result = analyzeCommonJsStaticFixture(
    "const {ipcMain}=require('electron'); ipcMain.on(channel, () => {});",
  );
  expect(result.parse_status).toBe("partial");
  expect(result.analysis_coverage).toMatchObject({
    syntax: { status: "complete", error_count: 0 },
    semantics: { unknown_findings: 1, uncertainty: ["dynamic-findings"] },
    examination: {
      status: "complete",
      semantic_resource_limits: [],
      electron_call_paths_limited: false,
    },
    applicability: { electron: "observed" },
  });
  expect(result.electron.ipc).toMatchObject([
    { channel: null, channel_expression: "channel" },
  ]);
});

it("distinguishes recovered syntax from unparseable source without inventing an error total", () => {
  const recovered = analyzeJavaScriptStaticSource("let value; let value;");
  expect(recovered.parse_status).toBe("partial");
  expect(recovered.analysis_coverage.syntax).toEqual({
    status: "recovered",
    error_count: recovered.parse_error_count,
  });
  const failed = analyzeJavaScriptStaticSource("const value = ;");
  expect(failed.parse_status).toBe("failed");
  expect(failed.analysis_coverage).toMatchObject({
    syntax: { status: "failed", error_count: null },
    semantics: { unknown_findings: null },
    examination: { status: "not-examined" },
  });
});

it("does not report complete parsing when the unknown-finding count is itself unknown", () => {
  const complete = analyzeJavaScriptStaticSource(
    "export const value = 1;",
  ).analysis_coverage;
  expect(javaScriptStaticParseStatus(complete)).toBe("complete");
  expect(
    javaScriptStaticParseStatus({
      ...complete,
      semantics: { ...complete.semantics, unknown_findings: null },
    }),
  ).toBe("partial");
});

it("keeps framework applicability unknown without positive Electron evidence", () => {
  const ordinary = analyzeJavaScriptStaticSource("export const value = 1;");
  expect(ordinary.parse_status).toBe("complete");
  expect(ordinary.analysis_coverage.applicability.electron).toBe("unknown");
  const electron = analyzeCommonJsStaticFixture(
    "const {ipcMain}=require('electron');",
  );
  expect(electron.analysis_coverage.applicability.electron).toBe("observed");
});

it("reports compiler-dependent module side effects independently of complete syntax", () => {
  const result = analyzeJavaScriptStaticSource(
    "import { type Config } from './config';",
  );
  expect(result.analysis_coverage.syntax).toEqual({
    status: "complete",
    error_count: 0,
  });
  expect(result.analysis_coverage.semantics.uncertainty).toContain(
    "type-only-module-side-effect",
  );
});

it("retains typed examination limits alongside successfully parsed source", () => {
  const result = analyzeJavaScriptStaticSource(aliasSelectionBudgetSource());
  expect(result.parse_status).toBe("partial");
  expect(result.analysis_coverage).toMatchObject({
    syntax: { status: "complete", error_count: 0 },
    examination: {
      status: "limited",
      semantic_resource_limits: ["alias-selections"],
    },
  });
});

it("keeps a CommonJS wrapper redeclaration out of recovered-syntax coverage", () => {
  const source =
    "const require={main:{require(){}}};require.main.require('../shared/window.cjs');";
  const file = parseJavaScriptSource(source, "a/main.cjs");
  expect(file).not.toBeNull();
  expect(file!.errors).toEqual([
    expect.objectContaining({
      reasonCode: "CommonJsWrapperLexicalDeclaration",
    }),
  ]);
  const result = analyzeParsedJavaScriptStaticSource(source, file!);
  expect(result.parse_status).toBe("complete");
  expect(result.parse_error_count).toBe(0);
  expect(result.references).toEqual([]);
  expect(result.analysis_coverage).toMatchObject({
    syntax: { status: "complete", error_count: 0 },
    semantics: {
      unknown_findings: 0,
      uncertainty: ["commonjs-wrapper-redeclaration"],
    },
    examination: { status: "complete" },
  });
});

it("preserves the legacy summary responsibility without relabeling independent limitations", () => {
  const base = analyzeJavaScriptStaticSource(
    "export const value = 1;",
  ).analysis_coverage;
  expect(
    javaScriptStaticParseStatus({
      ...base,
      semantics: {
        unknown_findings: 0,
        uncertainty: ["returned-reference-widening"],
      },
      examination: {
        ...base.examination,
        status: "limited",
        electron_call_paths_limited: true,
      },
    }),
  ).toBe("complete");
  expect(
    unexaminedJavaScriptStaticCoverage("Caller selected another source."),
  ).toMatchObject({
    syntax: { status: "not-examined", error_count: null },
    semantics: { unknown_findings: null },
    examination: { status: "not-examined" },
    unexamined_reason: "Caller selected another source.",
  });
});
