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
} as const;
const REGISTRATIONS = [
  "registerCommand",
  "registerTextEditorCommand",
  "createChatParticipant",
  "registerTool",
  "registerMcpServerDefinitionProvider",
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
  menus: z
    .array(z.strictObject({ menu: z.string(), commands: z.array(z.string()) }))
    .nullable(),
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
    "commands" | "commands_omitted" | "menus" | "keybindings" | "declarations"
  >;
  /** Entry point member paths declared by the package. */
  readonly entryPoints: readonly string[];
  /** Whether the package manifest declaring contributions was read. */
  readonly manifestRead: boolean;
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
  {
    complete,
    allDeclared,
  }: { readonly complete: boolean; readonly allDeclared: boolean },
) =>
  [...new Set([...(declared?.keys() ?? []), ...found.keys()])]
    .sort(compareUnicodeCodePoints)
    .map((id) => {
      const registrations = found.get(id) ?? [];
      const status: (typeof STATUSES)[number] =
        declared === null
          ? "undetermined"
          : !declared.has(id)
            ? allDeclared
              ? "registered_undeclared"
              : "undetermined"
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

/**
 * Files whose calls were not analyzed: skipped or unparsed sources, and call
 * analysis dropped under a resource limit.
 */
const unanalyzedFiles = (graph: JavaScriptSemanticGraph) => {
  const paths = new Set<string>();
  let any = false;
  for (const { family, reason, evidence } of graph.unknowns) {
    const dropped =
      reason === "incomplete-module" ||
      (reason === "resource-limit" && family === "call-flow");
    if (!dropped) continue;
    const { location } = evidence;
    const path = !location.available
      ? undefined
      : location.value.kind === "artifact-path"
        ? location.value.path
        : location.value.kind === "source-range"
          ? location.value.source
          : undefined;
    if (path !== undefined) {
      paths.add(path);
      any = true;
    } else if (reason === "incomplete-module") any = true;
  }
  return { paths, any };
};

/**
 * Which declared entries had their calls analyzed, and whether an absent
 * registration can be claimed at all.
 */
const callCoverage = (
  graph: JavaScriptSemanticGraph,
  entryPoints: readonly string[],
) => {
  // Graphs recorded without callee facts hide every registration.
  const recorded = graph.callee_fact_modules?.includes("vscode") === true;
  const unanalyzed = unanalyzedFiles(graph);
  const modules = new Set(graph.nodes.map((node) => node.identity.module_path));
  const entries = entryPoints.map((path) => ({
    path,
    analyzed:
      recorded &&
      [path, path.replace(/^extension\//u, "")].some(
        (name) => modules.has(name) && !unanalyzed.paths.has(name),
      ),
  }));
  const complete =
    recorded &&
    !graph.coverage.truncated &&
    !unanalyzed.any &&
    entries.length > 0 &&
    entries.every((entry) => entry.analyzed);
  return { entries, complete };
};

/**
 * Join declared command identifiers with literal VS Code registrations. A
 * missing registration is not proof that the command has no handler.
 */
export const correlateVsixRegistrations = ({
  contributes,
  entryPoints,
  manifestRead,
  semanticGraph,
}: CorrelationInput) => {
  const { byKind, unresolved } = registrationsOf(semanticGraph);
  const declared = firstById(
    contributes.commands.map(({ command, title }) => [command, title]),
  );
  const keys = groupBy(contributes.keybindings, ({ key }) => key);
  const { entries, complete } = callCoverage(semanticGraph, entryPoints);
  // An unread manifest or a capped older list cannot show an ID is undeclared.
  const allDeclared = manifestRead && contributes.commands_omitted === 0;
  const commands = joinDeclarations(declared, byKind.command, {
    complete,
    allDeclared,
  }).map(({ id, status, text, registrations }) => ({
    command: id,
    status,
    title: text,
    registrations,
    keybindings: keys === null ? null : (keys.get(id) ?? []),
  }));
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
      { complete, allDeclared: manifestRead },
    ).map(({ id, status, text, registrations }) => ({
      kind,
      id,
      status,
      label: text,
      registrations,
    })),
  );
  const tally = {
    registered: 0,
    not_found: 0,
    undetermined: 0,
    registered_undeclared: 0,
  };
  for (const { status } of commands) tally[status] += 1;
  const known = new Set(commands.map(({ command }) => command));
  // Grouped by menu so a long contributed menu name is retained once.
  const menus =
    contributes.menus?.map(({ menu, commands: ids }) => ({
      menu,
      commands: ids.filter((id): id is string => id !== null && known.has(id)),
    })) ?? null;
  return {
    commands,
    menus,
    contributions: declaredContributions,
    unresolved_registrations: unresolved,
    entry_points: entries,
    summary: {
      declared: declared.size,
      registered: tally.registered,
      not_found: tally.not_found,
      registered_undeclared: tally.registered_undeclared,
      undetermined: tally.undetermined,
      unresolved_registrations: unresolved.length,
    },
    semantic_graph_truncated: semanticGraph.coverage.truncated,
  };
};
