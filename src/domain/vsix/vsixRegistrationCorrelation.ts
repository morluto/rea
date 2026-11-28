import { z } from "zod";

import { evidenceInputSchema } from "../evidenceReference.js";
import type { JavaScriptSemanticGraph } from "../javascript/javascriptSemanticGraph.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { VSIX_CONTRIBUTION_KINDS, type VsixPackage } from "./vsixPackage.js";

/** Inline or exact retained Evidence for both sides of the correlation. */
export const correlateVsixRegistrationsInputSchema = z.strictObject({
  vsix_package: evidenceInputSchema.describe(
    "Complete inspect_vsix_package Evidence",
  ),
  javascript_application: evidenceInputSchema.describe(
    "Complete analyze_javascript_application Evidence for the same extension's extracted files",
  ),
});

/** The vscode functions that register each kind of contribution. */
const REGISTRATION_KINDS = {
  "commands.registerCommand": "command",
  "commands.registerTextEditorCommand": "command",
  "chat.createChatParticipant": "chat_participant",
  "lm.registerTool": "language_model_tool",
  "lm.registerMcpServerDefinitionProvider": "mcp_server_provider",
  "window.registerTreeDataProvider": "view",
  "window.createTreeView": "view",
  "window.registerWebviewViewProvider": "view",
  "window.registerCustomEditorProvider": "custom_editor",
} as const;
const REGISTRATIONS = [
  "registerCommand",
  "registerTextEditorCommand",
  "createChatParticipant",
  "registerTool",
  "registerMcpServerDefinitionProvider",
  "registerTreeDataProvider",
  "createTreeView",
  "registerWebviewViewProvider",
  "registerCustomEditorProvider",
] as const;
const STATUSES = [
  "registered",
  "not_found",
  "undetermined",
  "registered_undeclared",
] as const;

const registrationSchema = z.strictObject({
  function: z.enum(REGISTRATIONS),
  module_path: z.string(),
  line: z.int().positive().nullable(),
  column: z.int().nonnegative().nullable(),
  loader_authority: z.literal("candidate").nullable(),
  wrapper: z.literal("unverified").nullable(),
});
type Registration = z.output<typeof registrationSchema>;

const commandSchema = z.strictObject({
  command: z.string(),
  status: z.enum(STATUSES),
  title: z.string().nullable(),
  registrations: z.array(registrationSchema),
  menus: z.array(z.string()).nullable(),
  keybindings: z.array(z.string()).nullable(),
});

const contributionSchema = z.strictObject({
  kind: z.enum(VSIX_CONTRIBUTION_KINDS),
  id: z.string(),
  status: z.enum(STATUSES),
  label: z.string().nullable(),
  registrations: z.array(registrationSchema),
});

const count = z.int().nonnegative();
const correlationShape = {
  commands: z.array(commandSchema),
  contributions: z.array(contributionSchema),
  unresolved_registrations: z.array(registrationSchema),
  entry_points: z.array(
    z.strictObject({ path: z.string(), analyzed: z.boolean() }),
  ),
  summary: z.strictObject({
    declared: count,
    registered: count,
    not_found: count,
    registered_undeclared: count,
    undetermined: count,
    unresolved_registrations: count,
  }),
  semantic_graph_truncated: z.boolean(),
};

export const vsixRegistrationCorrelationSchema = z.strictObject({
  ...correlationShape,
  source_evidence: z.strictObject({
    vsix_package_evidence_id: z.string(),
    javascript_application_evidence_id: z.string(),
  }),
  limitations: z.array(z.string()),
});

interface CorrelationInput {
  readonly contributes: Pick<
    VsixPackage["contributes"],
    "commands" | "menus" | "keybindings" | "declarations"
  >;
  /** Entry point member paths declared by the package. */
  readonly entryPoints: readonly string[];
  readonly semanticGraph: JavaScriptSemanticGraph;
}

const calleeSchema = z.object({
  specifier: z.literal("vscode"),
  path: z.tuple([z.string(), z.enum(REGISTRATIONS)]),
  loader_authority: z.literal("candidate").optional(),
  wrapper: z.literal("unverified").optional(),
});
const argumentsSchema = z.array(
  z.object({ index: z.number(), value: z.unknown() }),
);
const isRegistrationPath = (
  path: string,
): path is keyof typeof REGISTRATION_KINDS =>
  Object.hasOwn(REGISTRATION_KINDS, path);
type Kind = (typeof REGISTRATION_KINDS)[keyof typeof REGISTRATION_KINDS];

/** Registration calls by kind and literal ID; other IDs stay unresolved. */
const registrationsOf = (graph: JavaScriptSemanticGraph) => {
  const byKind: Record<Kind, Map<string, Registration[]>> = {
    command: new Map(),
    chat_participant: new Map(),
    language_model_tool: new Map(),
    mcp_server_provider: new Map(),
    view: new Map(),
    custom_editor: new Map(),
  };
  const unresolved: Registration[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "call-site") continue;
    const callee = calleeSchema.safeParse(node.properties.module_callee);
    if (!callee.success) continue;
    const path = callee.data.path.join(".");
    if (!isRegistrationPath(path)) continue;
    const start = node.identity.source_range?.start;
    const registration: Registration = {
      function: callee.data.path[1],
      module_path: node.identity.module_path,
      line: start?.line ?? null,
      column: start?.column ?? null,
      loader_authority: callee.data.loader_authority ?? null,
      wrapper: callee.data.wrapper ?? null,
    };
    const literals = argumentsSchema.safeParse(node.properties.arguments);
    const id = literals.data?.find(({ index }) => index === 0)?.value;
    if (typeof id !== "string") {
      unresolved.push(registration);
      continue;
    }
    const byId = byKind[REGISTRATION_KINDS[path]];
    const found = byId.get(id);
    if (found === undefined) byId.set(id, [registration]);
    else found.push(registration);
  }
  return { byKind, unresolved };
};

/**
 * Join one kind's declared IDs with its registrations. Null declarations mean
 * they were not read, so nothing is called undeclared.
 */
const joinDeclarations = (
  declared: ReadonlyMap<string, string | null> | null,
  found: ReadonlyMap<string, Registration[]>,
  complete: boolean,
) =>
  [...new Set([...(declared?.keys() ?? []), ...found.keys()])]
    .sort(compareUnicodeCodePoints)
    .map((id) => {
      const registrations = found.get(id) ?? [];
      const status: (typeof STATUSES)[number] =
        declared === null
          ? "undetermined"
          : !declared.has(id)
            ? "registered_undeclared"
            : registrations.length > 0
              ? "registered"
              : complete
                ? "not_found"
                : "undetermined";
      return { id, status, text: declared?.get(id) ?? null, registrations };
    });

/** The first declared text for each non-null ID. */
const firstById = (
  rows: readonly (readonly [string | null, string | null])[],
) => {
  const declared = new Map<string, string | null>();
  for (const [id, text] of rows)
    if (id !== null && !declared.has(id)) declared.set(id, text);
  return declared;
};

const groupBy = <Row extends { readonly command: string | null }>(
  rows: readonly Row[] | null,
  value: (row: Row) => string | null,
) => {
  if (rows === null) return null;
  const groups = new Map<string, string[]>();
  for (const row of rows) {
    const item = value(row);
    if (row.command === null || item === null) continue;
    const group = groups.get(row.command);
    if (group === undefined) groups.set(row.command, [item]);
    else group.push(item);
  }
  return groups;
};

/** Files whose call analysis was dropped under a resource limit. */
const omittedCallFiles = (graph: JavaScriptSemanticGraph) =>
  new Set(
    graph.unknowns.flatMap(({ family, reason, evidence }) =>
      family === "call-flow" &&
      reason === "resource-limit" &&
      evidence.location.available &&
      evidence.location.value.kind === "artifact-path"
        ? [evidence.location.value.path]
        : [],
    ),
  );

/** Match a package member path or the same path relative to `extension/`. */
const analyzedEntry = (graph: JavaScriptSemanticGraph) => {
  const omitted = omittedCallFiles(graph);
  const modules = new Set(graph.nodes.map((node) => node.identity.module_path));
  return (entry: string) =>
    [entry, entry.replace(/^extension\//u, "")].some(
      (path) => modules.has(path) && !omitted.has(path),
    );
};

/**
 * Join declared command identifiers with literal VS Code registrations. A
 * missing registration is not proof that the command has no handler.
 */
export const correlateVsixRegistrations = ({
  contributes,
  entryPoints,
  semanticGraph,
}: CorrelationInput) => {
  const { byKind, unresolved } = registrationsOf(semanticGraph);
  const declared = firstById(
    contributes.commands.map(({ command, title }) => [command, title]),
  );
  const menus = groupBy(contributes.menus, ({ menu }) => menu);
  const keys = groupBy(contributes.keybindings, ({ key }) => key);
  const analyzed = analyzedEntry(semanticGraph);
  const entries = entryPoints.map((path) => ({
    path,
    analyzed: analyzed(path),
  }));
  // Absence needs every declared entry analyzed and no omitted analysis.
  const complete =
    !semanticGraph.coverage.truncated &&
    entries.length > 0 &&
    entries.every((entry) => entry.analyzed);
  const commands = joinDeclarations(declared, byKind.command, complete).map(
    ({ id, status, text, registrations }) => ({
      command: id,
      status,
      title: text,
      registrations,
      menus: menus === null ? null : (menus.get(id) ?? []),
      keybindings: keys === null ? null : (keys.get(id) ?? []),
    }),
  );
  const declaredContributions = VSIX_CONTRIBUTION_KINDS.flatMap((kind) =>
    joinDeclarations(
      contributes.declarations === null
        ? null
        : firstById(
            contributes.declarations
              .filter((row) => row.kind === kind)
              .map(({ id, label }) => [id, label]),
          ),
      byKind[kind],
      complete,
    ).map(({ id, status, text, registrations }) => ({
      kind,
      id,
      status,
      label: text,
      registrations,
    })),
  );
  const tally = (status: (typeof commands)[number]["status"]) =>
    commands.filter((command) => command.status === status).length;
  return {
    commands,
    contributions: declaredContributions,
    unresolved_registrations: unresolved,
    entry_points: entries,
    summary: {
      declared: declared.size,
      registered: tally("registered"),
      not_found: tally("not_found"),
      registered_undeclared: tally("registered_undeclared"),
      undetermined: tally("undetermined"),
      unresolved_registrations: unresolved.length,
    },
    semantic_graph_truncated: semanticGraph.coverage.truncated,
  };
};
