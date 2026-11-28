import { z } from "zod";

import { evidenceInputSchema } from "../evidenceReference.js";
import type { JavaScriptSemanticGraph } from "../javascript/javascriptSemanticGraph.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import type { VsixPackage } from "./vsixPackage.js";

/** Inline or exact retained Evidence for both sides of the correlation. */
export const correlateVsixRegistrationsInputSchema = z.strictObject({
  vsix_package: evidenceInputSchema.describe(
    "Complete inspect_vsix_package Evidence",
  ),
  javascript_application: evidenceInputSchema.describe(
    "Complete analyze_javascript_application Evidence for the same extension's extracted files",
  ),
});

const REGISTRATIONS = ["registerCommand", "registerTextEditorCommand"] as const;

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
  status: z.enum([
    "registered",
    "not_found",
    "undetermined",
    "registered_undeclared",
  ]),
  title: z.string().nullable(),
  registrations: z.array(registrationSchema),
  keybindings: z.array(z.string()).nullable(),
});

const count = z.int().nonnegative();
const correlationShape = {
  commands: z.array(commandSchema),
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
    "commands" | "commands_omitted" | "menus" | "keybindings"
  >;
  /** Entry point member paths declared by the package. */
  readonly entryPoints: readonly string[];
  /** Whether the package manifest declaring contributions was read. */
  readonly manifestRead: boolean;
  readonly semanticGraph: JavaScriptSemanticGraph;
}

const calleeSchema = z.object({
  specifier: z.literal("vscode"),
  path: z.tuple([z.literal("commands"), z.enum(REGISTRATIONS)]),
  loader_authority: z.literal("candidate").optional(),
  wrapper: z.literal("unverified").optional(),
});
const argumentsSchema = z.array(
  z.object({ index: z.number(), value: z.unknown() }),
);

/** Registration calls by literal identifier; other identifiers stay unresolved. */
const registrationsOf = (graph: JavaScriptSemanticGraph) => {
  const byCommand = new Map<string, Registration[]>();
  const unresolved: Registration[] = [];
  for (const node of graph.nodes) {
    if (node.kind !== "call-site") continue;
    const callee = calleeSchema.safeParse(node.properties.module_callee);
    if (!callee.success) continue;
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
    const found = byCommand.get(id);
    if (found === undefined) byCommand.set(id, [registration]);
    else found.push(registration);
  }
  return { byCommand, unresolved };
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
  const { byCommand, unresolved } = registrationsOf(semanticGraph);
  const declared = new Map<string, string | null>();
  for (const { command, title } of contributes.commands)
    if (command !== null && !declared.has(command))
      declared.set(command, title);
  const keys = groupBy(contributes.keybindings, ({ key }) => key);
  const { entries, complete } = callCoverage(semanticGraph, entryPoints);
  // An unread manifest or a capped older list cannot show an ID is undeclared.
  const allDeclared = manifestRead && contributes.commands_omitted === 0;
  const commands = [...new Set([...declared.keys(), ...byCommand.keys()])]
    .sort(compareUnicodeCodePoints)
    .map((command) => {
      const registrations = byCommand.get(command) ?? [];
      const status = !declared.has(command)
        ? allDeclared
          ? ("registered_undeclared" as const)
          : ("undetermined" as const)
        : registrations.length > 0
          ? ("registered" as const)
          : complete
            ? ("not_found" as const)
            : ("undetermined" as const);
      return {
        command,
        status,
        title: declared.get(command) ?? null,
        registrations,
        keybindings: keys === null ? null : (keys.get(command) ?? []),
      };
    });
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
