import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createPackage } from "@electron/asar";

import type { JsonValue } from "../domain/jsonValue.js";
import { javascriptApplicationAnalysisResultSchema } from "../domain/javascript/javascriptApplicationAnalysis.js";
import type { ApplicationNode } from "../domain/javascript/javascriptApplicationGraphSchemas.js";
import { javaScriptExportShapeComparisonResultSchema } from "../domain/javascript/javascriptExportShapeComparisonSchemas.js";
import {
  managedArtifactInspectionSchema,
  managedMemberInspectionSchema,
} from "../domain/managed/managedArtifact.js";
import {
  managedTokenScopesMatch,
  parseManagedInspectionEvidence,
} from "../domain/managed/managedInspectionEvidence.js";
import { compareUnicodeCodePoints } from "../domain/unicodeCodePointOrder.js";
import type {
  FixtureClaimContext,
  FixtureClaimExpectation,
} from "./KnownAnswerEvaluation.js";

/** Source-owned artifact paths used by the configured known-answer benchmarks. */
export interface AgentEvaluationFixtureTargets {
  readonly javascript: string;
  readonly javascriptSha256: string;
  readonly javascriptShapeLeft: string;
  readonly javascriptShapeRight: string;
  readonly managed?: string;
  readonly managedSha256?: string;
}

const desktopFixtureFiles = {
  "package.json": `${JSON.stringify({ name: "desktop-fixture", version: "1.0.0", main: "main.js" }, null, 2)}\n`,
  "main.js":
    'const { BrowserWindow, ipcMain } = require("electron");\nnew BrowserWindow({ webPreferences: { preload: require("node:path").join(__dirname, "preload.js"), contextIsolation: true, sandbox: true } });\nipcMain.handle("profile:read", (_event, id) => ({ id }));\n',
  "preload.js":
    'const { contextBridge, ipcRenderer } = require("electron");\ncontextBridge.exposeInMainWorld("profileApi", { read: (id) => ipcRenderer.invoke("profile:read", id) });\n',
  "renderer/app.js": 'globalThis.profileApi.read("fixture");\n',
};

/** Materialize the exact packaged and source-owned parser targets used by the runner. */
export const createAgentEvaluationFixtures = async (
  root: string,
  repositoryRoot: string,
): Promise<AgentEvaluationFixtureTargets> => {
  const desktop = join(root, "desktop-app");
  const javascript = join(root, "desktop-app.asar");
  const javascriptShapeLeft = join(root, "parser-v1");
  const javascriptShapeRight = join(root, "parser-v2");
  await Promise.all([
    mkdir(join(desktop, "renderer"), { recursive: true }),
    mkdir(javascriptShapeLeft, { recursive: true }),
    mkdir(javascriptShapeRight, { recursive: true }),
  ]);
  await Promise.all([
    ...Object.entries(desktopFixtureFiles).map(([path, source]) =>
      writeFile(join(desktop, path), source),
    ),
    cp(
      join(repositoryRoot, "tests/fixtures/replay/parser.mjs"),
      join(javascriptShapeLeft, "parser.mjs"),
    ),
    cp(
      join(repositoryRoot, "tests/fixtures/replay/parser-v2.mjs"),
      join(javascriptShapeRight, "parser.mjs"),
    ),
  ]);
  await createPackage(desktop, javascript);
  return {
    javascript,
    javascriptSha256: createHash("sha256")
      .update(await readFile(javascript))
      .digest("hex"),
    javascriptShapeLeft,
    javascriptShapeRight,
  };
};

type GraphObservation = ApplicationNode["observations"][number];

const singleObservation = (
  value: JsonValue,
  kind: ApplicationNode["kind"],
  include: (observation: GraphObservation) => boolean = () => true,
): GraphObservation | undefined => {
  const result = javascriptApplicationAnalysisResultSchema.safeParse(value);
  if (!result.success) return undefined;
  const candidates = result.data.graph.nodes
    .filter((node) => node.kind === kind)
    .flatMap((node) => node.observations)
    .filter(include);
  return candidates.length === 1 ? candidates[0] : undefined;
};

const observationSource = (
  observation: GraphObservation,
): string | undefined => {
  const location = observation.evidence.location;
  return location.available && location.value.kind === "source-range"
    ? location.value.source
    : undefined;
};

const rendererApi = (value: JsonValue): JsonValue | undefined => {
  const observation = singleObservation(value, "context-bridge-api");
  if (observation === undefined) return undefined;
  const { api_key: key, members, world } = observation.properties;
  const source = observationSource(observation);
  if (
    key === undefined ||
    members === undefined ||
    world === undefined ||
    source === undefined
  )
    return undefined;
  return { key, members, world, source };
};

const ipcOperation =
  (side: string) =>
  (value: JsonValue): JsonValue | undefined => {
    const observation = singleObservation(
      value,
      "ipc-channel",
      (candidate) => candidate.properties.side === side,
    );
    if (observation === undefined) return undefined;
    const { channel, operation } = observation.properties;
    const source = observationSource(observation);
    if (
      channel === undefined ||
      operation === undefined ||
      source === undefined
    )
      return undefined;
    return { channel, operation, source };
  };

const preload = (value: JsonValue): JsonValue | undefined => {
  const observation = singleObservation(
    value,
    "electron-preload",
    (candidate) =>
      candidate.properties.mechanism === "BrowserWindow:webPreferences.preload",
  );
  const path = observation?.properties.resolved_path;
  const resolutionStatus = observation?.properties.resolution_status;
  if (path === undefined || resolutionStatus === undefined) return undefined;
  return { path, resolution_status: resolutionStatus };
};

const headingChange = (value: JsonValue): JsonValue | undefined => {
  const result = javaScriptExportShapeComparisonResultSchema.safeParse(value);
  if (!result.success) return undefined;
  const changes = result.data.changes.filter(
    (change) => change.path === "/depth",
  );
  const change = changes.length === 1 ? changes[0] : undefined;
  if (change === undefined) return undefined;
  return {
    status: change.status,
    path: change.path,
    discriminant: change.discriminant,
    left: change.left,
    right: change.right,
  };
};

const comparisonCoverage = (value: JsonValue): JsonValue | undefined => {
  const result = javaScriptExportShapeComparisonResultSchema.safeParse(value);
  if (!result.success) return undefined;
  return {
    status: result.data.coverage.status,
    paired_variants: result.data.coverage.paired_variants,
    ...result.data.summary,
  };
};

const runtimeSemantics = (value: JsonValue): JsonValue | undefined => {
  const result = javaScriptExportShapeComparisonResultSchema.safeParse(value);
  return result.success &&
    result.data.limitations.includes(
      "Return shapes are inferred from inert syntax and do not prove runtime behavior.",
    )
    ? "not_established"
    : undefined;
};

const asarClaims = (
  targets: AgentEvaluationFixtureTargets,
): readonly FixtureClaimExpectation[] => {
  const source = {
    operation: "analyze_javascript_application",
    authority: "shipped-artifact",
    confidence: "derived",
    subject: { path: targets.javascript, sha256: targets.javascriptSha256 },
  } satisfies Omit<FixtureClaimExpectation["source"], "select">;
  return [
    {
      id: "renderer_api",
      expectedValue: {
        key: "profileApi",
        members: ["read"],
        world: "main",
        source: "preload.js",
      },
      source: { ...source, select: rendererApi },
    },
    {
      id: "renderer_ipc",
      expectedValue: {
        channel: "profile:read",
        operation: "invoke",
        source: "preload.js",
      },
      source: { ...source, select: ipcOperation("renderer") },
    },
    {
      id: "main_ipc",
      expectedValue: {
        channel: "profile:read",
        operation: "handle",
        source: "main.js",
      },
      source: { ...source, select: ipcOperation("main") },
    },
    {
      id: "preload",
      expectedValue: { path: "preload.js", resolution_status: "resolved" },
      source: { ...source, select: preload },
    },
  ];
};

const parserClaims = (
  targets: AgentEvaluationFixtureTargets,
): readonly FixtureClaimExpectation[] => {
  const source = {
    operation: "compare_javascript_export_shapes",
    authority: "analyst-inference",
    confidence: "inferred",
    parameters: {
      left_module_path: "parser.mjs",
      left_export_name: "default",
      right_module_path: "parser.mjs",
      right_export_name: "default",
    },
    linkedSubjects: [
      {
        operation: "analyze_javascript_application",
        path: targets.javascriptShapeLeft,
      },
      {
        operation: "analyze_javascript_application",
        path: targets.javascriptShapeRight,
      },
    ],
  } satisfies Omit<FixtureClaimExpectation["source"], "select">;
  return [
    {
      id: "heading_change",
      expectedValue: {
        status: "added",
        path: "/depth",
        discriminant: { path: "/type", value: "heading" },
        left: { availability: "absent" },
        right: { availability: "literal", value: 1 },
      },
      source: { ...source, select: headingChange },
    },
    {
      id: "comparison_coverage",
      expectedValue: {
        status: "complete-within-inputs",
        paired_variants: 3,
        added: 1,
        removed: 0,
        changed: 0,
        unknown: 0,
      },
      source: { ...source, select: comparisonCoverage },
    },
    {
      id: "runtime_semantics",
      expectedValue: "not_established",
      source: { ...source, select: runtimeSemantics },
    },
  ];
};

const managedMembers = ({ evidence }: FixtureClaimContext) => {
  const { result } = parseManagedInspectionEvidence(
    evidence,
    "inspect_managed_members",
    managedMemberInspectionSchema,
  );
  if (
    result.coverage.state !== "complete" ||
    result.metadata.status !== "complete" ||
    !managedTokenScopesMatch(
      result.identity_scope.requires_mvid,
      result.module?.mvid ?? null,
    )
  )
    return undefined;
  return result;
};

const managedClaims = (
  targets: AgentEvaluationFixtureTargets,
): readonly FixtureClaimExpectation[] => {
  if (targets.managed === undefined || targets.managedSha256 === undefined)
    throw new TypeError(
      "Managed fixture grading requires the built DLL path and SHA-256",
    );
  const source = {
    operation: "inspect_managed_members",
    authority: "shipped-artifact",
    confidence: "observed",
    subject: { path: targets.managed, sha256: targets.managedSha256 },
  } satisfies Omit<FixtureClaimExpectation["source"], "select">;
  return [
    {
      id: "public_types",
      expectedValue: ["AgentEval.Profile", "AgentEval.Program"],
      source: {
        ...source,
        select: (_value, context) => {
          const members = managedMembers(context);
          if (
            members === undefined ||
            members.selection !== null ||
            Object.hasOwn(context.evidence.parameters, "type_names")
          )
            return undefined;
          return members.types
            .filter((type) => (type.flags & 7) === 1)
            .map((type) => type.full_name)
            .sort(compareUnicodeCodePoints);
        },
      },
    },
    {
      id: "entry_point",
      expectedValue: { declaring_type: "AgentEval.Program", name: "Main" },
      source: {
        ...source,
        select: (_value, context) => {
          const members = managedMembers(context);
          if (members === undefined) return undefined;
          const artifacts = context.deliveredEvidence.filter(
            (evidence) =>
              evidence.operation === "inspect_managed_artifact" &&
              evidence.authority === source.authority &&
              evidence.confidence === source.confidence &&
              evidence.subject?.local_path === source.subject.path &&
              evidence.subject.digest.sha256 === source.subject.sha256,
          );
          if (artifacts.length !== 1) return undefined;
          const { result: artifact } = parseManagedInspectionEvidence(
            artifacts[0],
            "inspect_managed_artifact",
            managedArtifactInspectionSchema,
          );
          if (
            artifact.coverage.state !== "complete" ||
            artifact.metadata.status !== "complete" ||
            !managedTokenScopesMatch(
              artifact.module?.mvid ?? null,
              members.module?.mvid ?? null,
            ) ||
            artifact.pe.cli?.entry_point.kind !== "metadata-token"
          )
            return undefined;
          const methods = members.methods.filter(
            (method) => method.token === artifact.pe.cli?.entry_point.value,
          );
          const method = methods.length === 1 ? methods[0] : undefined;
          return method === undefined
            ? undefined
            : {
                declaring_type: method.declaring_type,
                name: method.name,
              };
        },
      },
    },
  ];
};

/** Return the closed known-answer rubric, or undefined for routing-only scenarios. */
export const agentFixtureClaims = (
  scenarioId: string,
  targets: AgentEvaluationFixtureTargets,
): readonly FixtureClaimExpectation[] | undefined => {
  if (scenarioId === "asar") return asarClaims(targets);
  if (scenarioId === "managed") return managedClaims(targets);
  if (scenarioId === "javascript-export-shape") return parserClaims(targets);
  return undefined;
};

const answerValueDescriptions: Readonly<Record<string, readonly string[]>> = {
  managed: [
    "public_types: string[], listing the exact public top-level type full names in Unicode code-point order from unfiltered member Evidence (omit type_names).",
    'entry_point: {"declaring_type": string, "name": string}, resolving the CLI metadata entry-point token against the member inventory from the same artifact SHA-256 and module MVID. Cite member Evidence; both artifact and member Evidence must be delivered.',
  ],
  asar: [
    'renderer_api: {"key": string, "members": string[], "world": string, "source": string}, describing the exposed bridge API, its members, world, and source file.',
    'renderer_ipc: {"channel": string, "operation": string, "source": string}, describing the renderer-side IPC operation and its source file.',
    'main_ipc: {"channel": string, "operation": string, "source": string}, describing the main-side IPC operation and its source file.',
    'preload: {"path": string, "resolution_status": string}, describing the BrowserWindow-declared preload resolved within the shipped artifact.',
  ],
  "javascript-export-shape": [
    'heading_change: {"status": string, "path": string, "discriminant": object or null, "left": object, "right": object}, copying the exact heading-change fields from the comparison result.',
    'comparison_coverage: {"status": string, "paired_variants": number, "added": number, "removed": number, "changed": number, "unknown": number}, copying comparison coverage and summary counts.',
    'runtime_semantics: "established" or "not_established", stating whether the cited comparison establishes runtime behavior.',
  ],
};

/** Describe the strict answer contract without revealing any golden fixture values. */
export const agentFixtureAnswerInstructions = (scenarioId: string): string => {
  const descriptions = answerValueDescriptions[scenarioId];
  if (descriptions === undefined) return "";
  return [
    "For this benchmark, return only one JSON object, without Markdown fences or surrounding prose.",
    'The exact shape is {"claims": [{"id": string, "value": JSON value, "evidence_id": string, "confidence": string, "authority": string}]}.',
    "Include exactly one claim per ID below, without additional fields or claims. Infer values only from REA tool results; do not read target files directly.",
    "Each evidence_id must identify the successful REA result that supports its claim. Copy confidence and authority from that result's Evidence envelope.",
    ...descriptions,
  ].join("\n");
};
