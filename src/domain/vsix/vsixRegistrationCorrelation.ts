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
  menus: z.array(z.string()).nullable(),
  keybindings: z.array(z.string()).nullable(),
});

const count = z.int().nonnegative();
const correlationShape = {
  commands: z.array(commandSchema),
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
    "commands" | "menus" | "keybindings"
  >;
  /** Entry point member paths declared by the package. */
  readonly entryPoints: readonly string[];
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
  const { byCommand, unresolved } = registrationsOf(semanticGraph);
  const declared = new Map<string, string | null>();
  for (const { command, title } of contributes.commands)
    if (command !== null && !declared.has(command))
      declared.set(command, title);
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
  const commands = [...new Set([...declared.keys(), ...byCommand.keys()])]
    .sort(compareUnicodeCodePoints)
    .map((command) => {
      const registrations = byCommand.get(command) ?? [];
      const status = !declared.has(command)
        ? ("registered_undeclared" as const)
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
        menus: menus === null ? null : (menus.get(command) ?? []),
        keybindings: keys === null ? null : (keys.get(command) ?? []),
      };
    });
  const tally = (status: (typeof commands)[number]["status"]) =>
    commands.filter((command) => command.status === status).length;
  return {
    commands,
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
