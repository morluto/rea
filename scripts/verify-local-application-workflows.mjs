#!/usr/bin/env node

import { realpath } from "node:fs/promises";
import { parseArgs } from "node:util";

import { analyzeJavaScriptApplication } from "../dist/application/JavaScriptApplicationService.js";
import {
  compareApplicationVersionsEvidence,
  compareJavaScriptExportShapesEvidence,
  traceApplicationFeatureEvidence,
} from "../dist/application/JavaScriptApplicationWorkflowService.js";
import { PermissionAuthority } from "../dist/application/PermissionAuthority.js";
import { applicationVersionComparisonResultSchema } from "../dist/domain/javascriptApplicationVersionComparisonSchemas.js";
import { applicationFeatureTraceResultSchema } from "../dist/domain/javascriptFeatureTraceSchemas.js";
import { javaScriptExportShapeComparisonResultSchema } from "../dist/domain/javascriptExportShapeComparisonSchemas.js";
import { createPermissionPolicy } from "../dist/domain/permissionPolicy.js";

const options = parseArgs({
  options: {
    left: { type: "string" },
    right: { type: "string" },
    "seed-kind": { type: "string", default: "module" },
    "seed-value": { type: "string" },
    "source-map-read-approved": { type: "boolean", default: false },
    "left-module-path": { type: "string" },
    "left-export-name": { type: "string" },
    "right-module-path": { type: "string" },
    "right-export-name": { type: "string" },
  },
  strict: true,
  allowPositionals: false,
}).values;

if (options.left === undefined || options.right === undefined)
  throw new Error(
    "--left and --right must name operator-provided app/ASAR paths",
  );
const [leftPath, rightPath] = await Promise.all([
  realpath(options.left),
  realpath(options.right),
]);
if (leftPath === rightPath)
  throw new Error("--left and --right must resolve to distinct paths");
const authority = permissionAuthority([leftPath, rightPath]);
const [left, right] = await Promise.all([
  analyze(leftPath, authority),
  analyze(rightPath, authority),
]);
const comparison = compareApplicationVersionsEvidence({ left, right });
if (!comparison.ok) throw comparison.error;
const comparisonResult = applicationVersionComparisonResultSchema.parse(
  comparison.value.normalized_result,
);
const seedValue =
  options["seed-value"] ??
  left.normalized_result.graph.nodes.find(
    ({ kind }) => kind === "javascript-module",
  )?.observations[0]?.label;
const trace =
  seedValue === undefined
    ? null
    : traceApplicationFeatureEvidence({
        application: left,
        seed: {
          kind: options["seed-kind"],
          value: seedValue,
          match: "exact",
          case_sensitive: false,
        },
        direction: "both",
      });
if (trace !== null && !trace.ok) throw trace.error;
const traceResult =
  trace === null
    ? null
    : applicationFeatureTraceResultSchema.parse(trace.value.normalized_result);
const exportShapeSelector = resolveExportShapeSelector(left, right, options);
const exportShapeComparison =
  exportShapeSelector === null
    ? null
    : compareJavaScriptExportShapesEvidence({
        left,
        right,
        ...exportShapeSelector,
      });
if (exportShapeComparison !== null && !exportShapeComparison.ok)
  throw exportShapeComparison.error;
const exportShapeResult =
  exportShapeComparison === null
    ? null
    : javaScriptExportShapeComparisonResultSchema.parse(
        exportShapeComparison.value.normalized_result,
      );

process.stdout.write(
  `${JSON.stringify({
    comparison_id: comparisonResult.comparison_id,
    evidence_id: comparison.value.evidence_id,
    left: comparisonResult.left,
    right: comparisonResult.right,
    summary: comparisonResult.summary,
    matching: comparisonResult.matching,
    coverage: comparisonResult.coverage,
    export_shape_comparison:
      exportShapeResult === null
        ? null
        : {
            comparison_id: exportShapeResult.comparison_id,
            evidence_id: exportShapeComparison.value.evidence_id,
            left: exportShapeResult.left,
            right: exportShapeResult.right,
            summary: exportShapeResult.summary,
            changes: exportShapeResult.changes,
            coverage: exportShapeResult.coverage,
            runtime_validation: exportShapeResult.runtime_validation,
          },
    trace:
      traceResult === null
        ? null
        : {
            trace_id: traceResult.trace_id,
            evidence_id: trace.value.evidence_id,
            seed: traceResult.seed,
            summary: traceResult.summary,
            coverage: traceResult.coverage,
            native_handoffs: traceResult.native_handoffs.map((handoff) => ({
              artifact_sha256: handoff.artifact_sha256,
              status: handoff.status,
              requested_exports: handoff.requested_exports,
              evidence_ids: handoff.evidence_ids,
            })),
          },
    verified: true,
  })}\n`,
);

function resolveExportShapeSelector(left, right, values) {
  const explicit = [
    values["left-module-path"],
    values["left-export-name"],
    values["right-module-path"],
    values["right-export-name"],
  ];
  if (explicit.some((value) => value !== undefined)) {
    if (explicit.some((value) => value === undefined))
      throw new Error(
        "Explicit export-shape verification requires all left/right module and export selectors",
      );
    return {
      left_module_path: explicit[0],
      left_export_name: explicit[1],
      right_module_path: explicit[2],
      right_export_name: explicit[3],
    };
  }
  const leftSelectors = returnShapeSelectors(left.normalized_result.graph);
  const rightSelectors = new Set(
    returnShapeSelectors(right.normalized_result.graph).map(selectorKey),
  );
  const common = leftSelectors.find((selector) =>
    rightSelectors.has(selectorKey(selector)),
  );
  return common === undefined
    ? null
    : {
        left_module_path: common.modulePath,
        left_export_name: common.exportName,
        right_module_path: common.modulePath,
        right_export_name: common.exportName,
      };
}

function returnShapeSelectors(graph) {
  const selectors = [];
  for (const node of graph.nodes) {
    for (const observation of node.observations) {
      const properties = observation.properties;
      if (
        properties.semantic_role === "export-return-shapes" &&
        typeof properties.module_path === "string" &&
        typeof properties.exported_name === "string"
      )
        selectors.push({
          modulePath: properties.module_path,
          exportName: properties.exported_name,
        });
    }
  }
  return selectors.sort((left, right) =>
    selectorKey(left).localeCompare(selectorKey(right), "en"),
  );
}

function selectorKey(selector) {
  return `${selector.modulePath}\0${selector.exportName}`;
}

async function analyze(path, authority) {
  const result = await analyzeJavaScriptApplication(authority, {
    input_path: path,
    approved: true,
    source_map_read_approved: options["source-map-read-approved"],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function permissionAuthority(roots) {
  const scope = {
    capability: "investigation_input",
    roots,
    executables: [],
    environment_names: [],
    network: "none",
    mount: false,
  };
  return new PermissionAuthority(
    createPermissionPolicy(
      [scope],
      [
        {
          ...scope,
          grant_id: "local-application-workflow-verifier",
          lifetime: "session",
          operation_identity: null,
          expires_at: null,
        },
      ],
    ),
  );
}
