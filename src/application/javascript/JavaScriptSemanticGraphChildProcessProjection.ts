import type { JavaScriptSemanticGraphNode } from "../../domain/javascript/javascriptSemanticGraphSchemas.js";
import type {
  JavaScriptSemanticChildProcessInteraction,
  JavaScriptSemanticChildProcessSpawn,
} from "../../domain/javascript/javascriptSemanticIr.js";
import {
  retainSemanticGraphNode,
  addSemanticGraphRelation,
  addSemanticGraphUnknown,
} from "./JavaScriptSemanticGraphConstruction.js";
import {
  unknownSemanticEvidence,
  candidateBuiltinSemanticEvidence,
  builtinSemanticRelation,
} from "./JavaScriptSemanticGraphEvidence.js";
import {
  projectSemanticResultBindings,
  type SemanticFlowProjectionContext,
} from "./JavaScriptSemanticGraphFlowProjection.js";

interface ChildUnknownInput {
  readonly context: SemanticFlowProjectionContext;
  readonly node: JavaScriptSemanticGraphNode | null;
  readonly location: JavaScriptSemanticChildProcessSpawn["location"];
  readonly relationKinds: readonly (
    | "spawns"
    | "forwards-signal"
    | "listens-exit"
    | "listens-error"
    | "connects-stdio"
  )[];
  readonly reason?: "unknown-value";
  readonly detail: string;
  readonly candidateNodeIds: readonly string[];
}

/** Project child creation, argv/env/stdio, listeners, and signals. */
export const projectSemanticChildProcesses = (
  context: SemanticFlowProjectionContext,
): void => {
  const processNodes = new Map(
    context.ir.childProcessSpawns.flatMap((spawn) => {
      const node = addChildProcessNode(context, spawn);
      return node === null ? [] : [[spawn.processId, node] as const];
    }),
  );
  for (const spawn of context.ir.childProcessSpawns) {
    const child = processNodes.get(spawn.processId);
    if (child === undefined) continue;
    projectSpawn(context, spawn, child);
  }
  for (const interaction of context.ir.childProcessInteractions)
    projectInteraction(context, interaction, processNodes);
};

const addChildProcessNode = (
  context: SemanticFlowProjectionContext,
  spawn: JavaScriptSemanticChildProcessSpawn,
): JavaScriptSemanticGraphNode | null =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "child-process",
    roleKey: spawn.processId,
    location: spawn.location,
    label: spawn.command ?? spawn.method,
    functionNodeId:
      spawn.ownerCallableId === null
        ? null
        : (context.callableNodes.get(spawn.ownerCallableId)?.node_id ?? null),
    ...(spawn.builtinAuthority === "candidate"
      ? {
          evidence: candidateBuiltinSemanticEvidence(
            context.file,
            spawn.location,
          ),
        }
      : {}),
    properties: {
      ...(spawn.builtinAuthority === "candidate"
        ? { builtin_authority: "candidate" }
        : {}),
      argv_count: spawn.argvCount,
      command: spawn.command,
      environment_supplied: spawn.environmentSupplied,
      method: spawn.method,
      stdio_mode: spawn.stdioMode,
    },
  });

const projectSpawn = (
  context: SemanticFlowProjectionContext,
  spawn: JavaScriptSemanticChildProcessSpawn,
  child: JavaScriptSemanticGraphNode,
): void => {
  const callSite = context.callSiteAt(spawn.location);
  const authority = builtinSemanticRelation(
    context.file,
    spawn,
    spawn.resolution === "complete" ? "resolved" : "candidate",
  );
  const candidateEvidence = authority.evidence;
  addSemanticGraphRelation(context.state, {
    source: callSite,
    target: child,
    relation: "spawns",
    ...authority,
    ...(candidateEvidence === undefined
      ? {}
      : {
          properties: { builtin_authority: "candidate" },
        }),
  });
  projectSemanticResultBindings(
    context,
    child,
    spawn.projectedResultBindings,
    candidateEvidence,
  );
  if (spawn.argvCount !== null)
    addSemanticGraphRelation(context.state, {
      source: callSite,
      target: child,
      relation: "supplies-argv",
      resolution: candidateEvidence === undefined ? "resolved" : "candidate",
      ...(candidateEvidence === undefined
        ? {}
        : { evidence: candidateEvidence }),
      properties: { argument_count: spawn.argvCount },
    });
  if (spawn.environmentSupplied)
    addSemanticGraphRelation(context.state, {
      source: callSite,
      target: child,
      relation: "supplies-env",
      resolution: candidateEvidence === undefined ? "resolved" : "candidate",
      ...(candidateEvidence === undefined
        ? {}
        : { evidence: candidateEvidence }),
    });
  const stdio = addStdioNode(context, spawn, child);
  addSemanticGraphRelation(context.state, {
    source: child,
    target: stdio,
    relation: "connects-stdio",
    resolution:
      candidateEvidence !== undefined || spawn.stdioMode === "dynamic"
        ? "candidate"
        : "resolved",
    ...(candidateEvidence === undefined ? {} : { evidence: candidateEvidence }),
  });
  if (spawn.stdioMode === "dynamic")
    addChildUnknown({
      context,
      node: child,
      location: spawn.location,
      relationKinds: ["connects-stdio"],
      reason: "unknown-value",
      detail: `Static ${spawn.method} stdio options remain unresolved.`,
      candidateNodeIds: [],
    });
  if (candidateEvidence !== undefined)
    addChildUnknown({
      context,
      node: child,
      location: spawn.location,
      relationKinds: ["spawns"],
      detail:
        "The child-process identity is conditional on loader or mutation facts.",
      candidateNodeIds: [child.node_id],
    });
  if (spawn.resolution !== "complete")
    addChildUnknown({
      context,
      node: child,
      location: spawn.location,
      relationKinds: ["spawns"],
      detail: `Static ${spawn.method} command remains unresolved.`,
      candidateNodeIds: [],
    });
};

const addStdioNode = (
  context: SemanticFlowProjectionContext,
  spawn: JavaScriptSemanticChildProcessSpawn,
  child: JavaScriptSemanticGraphNode,
): JavaScriptSemanticGraphNode | null =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "stdio",
    roleKey: `stdio:${spawn.processId}`,
    location: spawn.location,
    label: spawn.stdioMode,
    functionNodeId: child.function_node_id,
    ...(spawn.builtinAuthority === "candidate"
      ? {
          evidence: candidateBuiltinSemanticEvidence(
            context.file,
            spawn.location,
          ),
        }
      : {}),
    properties: {
      mode: spawn.stdioMode,
      ...(spawn.builtinAuthority === "candidate"
        ? { builtin_authority: "candidate" }
        : {}),
    },
  });

const projectInteraction = (
  context: SemanticFlowProjectionContext,
  interaction: JavaScriptSemanticChildProcessInteraction,
  processNodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
): void => {
  const authority = builtinSemanticRelation(
    context.file,
    interaction,
    interaction.resolution === "complete" ? "resolved" : "candidate",
  );
  const candidateEvidence = authority.evidence;
  const children = interaction.linkedProcessIds.flatMap((identifier) => {
    const child = processNodes.get(identifier);
    return child === undefined ? [] : [child];
  });
  const effect =
    interaction.kind === "listener"
      ? addChildListenerNode(context, interaction)
      : addSignalNode(context, interaction);
  for (const child of children)
    addSemanticGraphRelation(context.state, {
      source: interaction.kind === "listener" ? child : effect,
      target: interaction.kind === "listener" ? effect : child,
      relation:
        interaction.kind === "signal"
          ? "forwards-signal"
          : interaction.eventName === "exit"
            ? "listens-exit"
            : "listens-error",
      ...authority,
      ...(candidateEvidence === undefined
        ? {}
        : {
            properties: { builtin_authority: "candidate" },
          }),
    });
  if (interaction.resolution !== "complete")
    addChildUnknown({
      context,
      node: effect,
      location: interaction.location,
      relationKinds: [
        interaction.kind === "signal"
          ? "forwards-signal"
          : interaction.eventName === "exit"
            ? "listens-exit"
            : "listens-error",
      ],
      detail: `Static child ${interaction.method} ownership is ambiguous.`,
      candidateNodeIds: children.map(({ node_id: identifier }) => identifier),
    });
};

const addChildListenerNode = (
  context: SemanticFlowProjectionContext,
  interaction: JavaScriptSemanticChildProcessInteraction,
): JavaScriptSemanticGraphNode | null =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "listener",
    roleKey: interaction.interactionId,
    location: interaction.listenerLocation ?? interaction.location,
    label: interaction.eventName,
    functionNodeId:
      interaction.ownerCallableId === null
        ? null
        : (context.callableNodes.get(interaction.ownerCallableId)?.node_id ??
          null),
    ...(interaction.builtinAuthority === "candidate"
      ? {
          evidence: candidateBuiltinSemanticEvidence(
            context.file,
            interaction.location,
          ),
        }
      : {}),
    properties: {
      ...(interaction.builtinAuthority === "candidate"
        ? { builtin_authority: "candidate" }
        : {}),
      event_name: interaction.eventName,
      method: interaction.method,
    },
  });

const addSignalNode = (
  context: SemanticFlowProjectionContext,
  interaction: JavaScriptSemanticChildProcessInteraction,
): JavaScriptSemanticGraphNode | null =>
  retainSemanticGraphNode(context.state, context.file, {
    kind: "signal",
    roleKey: interaction.interactionId,
    location: interaction.location,
    label: interaction.signalName,
    functionNodeId:
      interaction.ownerCallableId === null
        ? null
        : (context.callableNodes.get(interaction.ownerCallableId)?.node_id ??
          null),
    ...(interaction.builtinAuthority === "candidate"
      ? {
          evidence: candidateBuiltinSemanticEvidence(
            context.file,
            interaction.location,
          ),
        }
      : {}),
    properties: {
      signal_name: interaction.signalName,
      ...(interaction.builtinAuthority === "candidate"
        ? { builtin_authority: "candidate" }
        : {}),
    },
  });

const addChildUnknown = (input: ChildUnknownInput): void => {
  const { context, node, location, relationKinds, detail, candidateNodeIds } =
    input;
  addSemanticGraphUnknown(context.state, {
    node_id: node?.node_id ?? null,
    family: "child-process",
    relation_kinds: relationKinds,
    reason: input.reason ?? "ambiguous-target",
    detail,
    candidate_node_ids: candidateNodeIds,
    evidence: unknownSemanticEvidence(context.file, location),
  });
};
