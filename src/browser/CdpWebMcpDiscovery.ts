import type { CdpFrameFacts } from "./CdpFrameIdentity.js";
import { cdpFrameEvent } from "./protocol/CdpEvents.js";

import type { ProgressReporter } from "../ports/ProgressReporter.js";
import type {
  DiscoverWebMcpToolsInput,
  WebMcpDiscovery,
} from "../domain/webMcpDiscovery.js";
import { jsonValueSchema } from "../domain/jsonValue.js";
import { digestCanonicalValue } from "../domain/canonicalDigest.js";
import {
  compareUnicodeCodePoints,
  compositeKey,
} from "../domain/unicodeCodePointOrder.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection, CdpReceivedEvent } from "./CdpConnection.js";
import { onCdpTargetEvent } from "./CdpTargetEvents.js";
import { CdpTargetDocument } from "./CdpTargetDocument.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { BrowserObservationError } from "../domain/browserObservationError.js";
import { cdpOriginScopeRefusal } from "./CdpOriginScopeError.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
  numberValue,
  recordValue,
  cdpStringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import {
  classifyCdpFrameUrl,
  type CdpFrameUrlObservation,
} from "./CdpCaptureDocuments.js";
import {
  observedFrameUrl,
  type CdpFrameTree,
} from "./protocol/CdpFrameTree.js";
import {
  cdpRootDocument,
  unverifiedDocumentLimitation,
  type CdpDocumentIdentity,
} from "./CdpTargetSession.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import {
  cdpSourceCoordinates,
  topCallFrame,
} from "./CdpCaptureEventHelpers.js";
import { sha256Hex } from "../kernel/sha256Hex.js";

interface DiscoveryContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: DiscoverWebMcpToolsInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

/** Discover WebMCP registrations without evaluating or invoking page code. */
export const discoverWebMcp = async (
  context: DiscoveryContext,
): Promise<WebMcpDiscovery> => {
  const origins = new Set(context.input.allowed_origins);
  const limitations = [
    "Page-declared tool metadata is untrusted and is never registered or invoked by REA.",
    "Discovery uses only WebMCP.enable and toolsAdded/toolsRemoved; WebMCP.invokeTool is never called.",
  ];
  const completeness = new CdpCaptureCompleteness();
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const frameTree = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const document = CdpTargetDocument.watch(
    context,
    requiredDiscoveryFrame(frameTree, origins),
  );
  document.observeTree(frameTree);
  const frameUrls = new Map<string, FrameScopeFrame>();
  const tools = new Map<string, WebMcpDiscovery["tools"]["items"][number]>();
  const frameScope = {
    origins,
    frames: frameUrls,
    tools,
    completeness,
    transientFrames: new Set<string>(),
    resolvedTransientFrames: new Set<string>(),
  };
  ingestInitialFrameTree(frameTree, frameScope);
  if (
    [...frameUrls.values()].some(
      (frame) => frame.parentFrameId !== null && frame.origin !== null,
    )
  ) {
    completeness.attachLimited("webmcp_tools");
    limitations.push(
      "WebMCP.enable replay does not establish coverage of pre-existing subframe registrations. Later live registrations are retained, but cannot recover descriptors omitted before attachment.",
    );
  }
  // Only a proven document change removes a subframe's tools. An unknown
  // comparison keeps them, and the owner keeps that identity unknown, so the
  // result reports them as unverified (`unverifiedSubframeTools`).
  document.onFrameDocumentChanged((frameId) =>
    removeFrameTools(frameId, tools),
  );
  const removeListener = onCdpTargetEvent(
    context.connection,
    context.sessionId,
    (event) => {
      if (ingestFrameScopeEvent(event, frameScope)) return;
      ingestWebMcpEvent({
        event,
        input: context.input,
        frames: frameUrls,
        tools,
        completeness,
        transientFrames: frameScope.transientFrames,
        resolvedTransientFrames: frameScope.resolvedTransientFrames,
      });
    },
  );
  let result: ReturnType<typeof buildWebMcpResult>;
  try {
    await context.progress?.report({
      phase: "browser_observation",
      completed: 1,
      total: 2,
      message: "Enabling passive WebMCP discovery",
    });
    const enabled = await optionalCdpCommand(
      context,
      "WebMCP.enable",
      {},
      limitations,
    );
    // WebMCP.enable is an acknowledgement; a malformed one is a protocol error.
    if (!enabled.ok && enabled.error._tag === "CdpMalformedReply")
      throw enabled.error.reply;
    const available = enabled.ok;
    if (!available) {
      completeness.unavailable("webmcp_tools");
    } else
      // CDP sends the enable response before the required toolsAdded replay.
      await delayWithCancellation(
        context.input.observation_ms,
        "discover_webmcp_tools",
        context.signal,
      );
    await assertStableAuthorizedFrame(context, document, origins, {
      completeness,
      limitations,
    });
    if (frameScope.transientFrames.size > 0)
      completeness.attachLimited("webmcp_tools");
    const unverified = unverifiedSubframeTools(document, frameUrls, tools);
    if (unverified.length > 0) {
      completeness.attachLimited("webmcp_tools");
      limitations.push(
        `Document identity could not be established for frames ${unverified.join(", ")}: CDP reported no loader for a committed navigation, so tools listed for those frames may belong to an earlier document.`,
      );
    }
    result = buildWebMcpResult({
      context,
      frameTree,
      tools,
      completeness,
      limitations,
      available,
    });
  } finally {
    removeListener();
    document.close();
  }
  await context.progress?.report({
    phase: "browser_observation",
    completed: 2,
    total: 2,
    message: "WebMCP discovery complete",
    terminal: true,
  });
  return result;
};

interface FrameScopeState {
  readonly origins: ReadonlySet<string>;
  readonly frames: Map<string, FrameScopeFrame>;
  readonly tools: Map<string, WebMcpDiscovery["tools"]["items"][number]>;
  readonly completeness: CdpCaptureCompleteness;
  readonly transientFrames: Set<string>;
  readonly resolvedTransientFrames: Set<string>;
}

interface FrameScopeFrame {
  readonly url: string;
  readonly origin: string | null;
  readonly parentFrameId: string | null;
}

const ingestInitialFrameTree = (
  frameTree: CdpFrameTree,
  state: FrameScopeState,
): void => {
  if (frameTree.omittedFrames)
    state.completeness.exclude("webmcp_tools", "invalid_protocol_value", null);
  for (const node of frameTree.frames) {
    const { facts } = node;
    if (node !== frameTree.root && facts.parentRelation === "root") {
      invalidateFrameFacts(facts, state);
      continue;
    }
    handleFrameUpdate(facts, state, node.url);
  }
};

const ingestFrameScopeEvent = (
  event: CdpReceivedEvent,
  state: FrameScopeState,
): boolean => {
  const frame = cdpFrameEvent(event);
  if (frame === undefined) return false;
  const { facts, url } = frame;
  switch (facts.kind) {
    case "detached":
      if (facts.identityIssue !== null || facts.frameId === null) {
        invalidateFrameFacts(facts, state);
        return true;
      }
      removeFrame(facts.frameId, state.frames, state.tools);
      state.transientFrames.delete(facts.frameId);
      state.resolvedTransientFrames.delete(facts.frameId);
      return true;
    case "navigated":
    case "within_document":
      return handleFrameUpdate(facts, state, url);
    default:
      return false;
  }
};

/** Malformed declarations cannot preserve cached authority for an attributable frame. */
const invalidateFrameFacts = (
  facts: CdpFrameFacts,
  state: FrameScopeState,
): void => {
  state.completeness.exclude("webmcp_tools", "invalid_protocol_value");
  if (facts.frameId === null) return;
  removeFrame(facts.frameId, state.frames, state.tools);
  state.transientFrames.delete(facts.frameId);
  state.resolvedTransientFrames.delete(facts.frameId);
};

const handleFrameUpdate = (
  sourceFacts: CdpFrameFacts,
  state: FrameScopeState,
  observation: CdpFrameUrlObservation,
): boolean => {
  const documentCommitted = sourceFacts.kind !== "within_document";
  const frameId = sourceFacts.frameId;
  if (
    sourceFacts.identityIssue !== null ||
    sourceFacts.parentIssue !== null ||
    sourceFacts.loaderIssue !== null ||
    frameId === null
  ) {
    invalidateFrameFacts(sourceFacts, state);
    return true;
  }
  const facts = classifyCdpFrameUrl(observation, state.origins);
  if (observation.kind !== "observed") {
    removeFrameTools(frameId, state.tools);
    state.frames.delete(frameId);
    state.resolvedTransientFrames.delete(frameId);
    state.completeness.exclude("webmcp_tools", "invalid_protocol_value");
    if (facts.scope === "outside_policy") {
      state.transientFrames.delete(frameId);
      state.completeness.exclude("webmcp_tools", "out_of_target_scope");
    } else state.transientFrames.add(frameId);
    return true;
  }
  // Chromium can briefly commit an inherited, empty document while replacing
  // a subframe. That intermediate URL says nothing about the frame's eventual
  // scope or its registered tools; wait for a committed URL and fresh replay.
  // Without those observations, discovery remains attach-limited.
  if (isTransientFrameUrl(observation.scopeUrl)) {
    if (documentCommitted) {
      removeFrameTools(frameId, state.tools);
      state.transientFrames.add(frameId);
      state.resolvedTransientFrames.delete(frameId);
    }
    return true;
  }
  updateFrameScope(sourceFacts, frameId, facts, state, documentCommitted);
  return true;
};

const updateFrameScope = (
  sourceFacts: CdpFrameFacts,
  frameId: string,
  facts: ReturnType<typeof classifyCdpFrameUrl>,
  state: FrameScopeState,
  documentCommitted: boolean,
): void => {
  if (facts.url === undefined || facts.origin === null) {
    removeFrameTools(frameId, state.tools);
    state.frames.delete(frameId);
    state.transientFrames.delete(frameId);
    state.resolvedTransientFrames.delete(frameId);
    state.completeness.exclude("webmcp_tools", "out_of_target_scope");
    return;
  }
  const previous = state.frames.get(frameId);
  if (documentCommitted && state.transientFrames.has(frameId))
    state.resolvedTransientFrames.add(frameId);
  state.frames.set(frameId, {
    url: facts.url,
    origin: facts.origin,
    parentFrameId:
      sourceFacts.parentRelation === "not_applicable"
        ? (previous?.parentFrameId ?? null)
        : sourceFacts.parentId,
  });
};

/**
 * Subframes whose tools are kept although a committed navigation could not be
 * compared with their earlier document (CDP reported no loader). Their tools
 * stay visible, but may belong to that earlier document.
 */
const unverifiedSubframeTools = (
  document: CdpTargetDocument,
  frames: ReadonlyMap<string, FrameScopeFrame>,
  tools: ReadonlyMap<string, WebMcpDiscovery["tools"]["items"][number]>,
): string[] => {
  const withTools = new Set([...tools.values()].map((tool) => tool.frame_id));
  return [...frames]
    .filter(
      ([frameId, frame]) =>
        frame.parentFrameId !== null &&
        document.frameDocumentUnknown(frameId) &&
        withTools.has(frameId),
    )
    .map(([frameId]) => frameId)
    .sort(compareUnicodeCodePoints);
};

const removeFrameTools = (
  frameId: string,
  tools: Map<string, WebMcpDiscovery["tools"]["items"][number]>,
): void => {
  for (const [key, tool] of tools)
    if (tool.frame_id === frameId) tools.delete(key);
};

const isTransientFrameUrl = (url: string): boolean => {
  if (url === "") return true;
  try {
    const base = new URL(url);
    return (
      base.protocol === "about:" &&
      base.search === "" &&
      (base.pathname === "blank" || base.pathname === "srcdoc")
    );
  } catch (cause: unknown) {
    void cause;
    return false;
  }
};

const removeFrame = (
  frameId: string,
  frames: Map<string, FrameScopeFrame>,
  tools: Map<string, WebMcpDiscovery["tools"]["items"][number]>,
): void => {
  const pending = [frameId];
  const removed = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || removed.has(current)) continue;
    removed.add(current);
    for (const [candidate, frame] of frames)
      if (frame.parentFrameId === current) pending.push(candidate);
    frames.delete(current);
  }
  for (const [key, tool] of tools)
    if (removed.has(tool.frame_id)) tools.delete(key);
};

/**
 * Check the final document before its scope: a document changed since
 * selection is `target_changed`; a missing loader leaves coverage limited,
 * with the selected document kept as the evidence subject.
 */
const assertStableAuthorizedFrame = async (
  context: DiscoveryContext,
  document: CdpTargetDocument,
  origins: ReadonlySet<string>,
  coverage: {
    readonly completeness: CdpCaptureCompleteness;
    readonly limitations: string[];
  },
): Promise<void> => {
  const finalTree = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  document.observe(discoveryDocument(finalTree));
  if (document.changed)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
  requiredDiscoveryFrame(finalTree, origins);
  if (document.unknown) {
    coverage.completeness.attachLimited("webmcp_tools");
    coverage.limitations.push(unverifiedDocumentLimitation(document.selected));
  }
};

const discoveryDocument = (tree: CdpFrameTree): CdpDocumentIdentity => {
  const document = cdpRootDocument(tree);
  if (document === undefined)
    throw new BrowserObservationError(
      "discover_webmcp_tools",
      "protocol_error",
    );
  return document;
};

/** Authorize the reply root's scope, then read its document identity. */
const requiredDiscoveryFrame = (
  tree: CdpFrameTree,
  origins: ReadonlySet<string>,
): CdpDocumentIdentity => {
  const observed = tree.root.url;
  const facts = classifyCdpFrameUrl(observed, origins);
  if (facts.scope === "outside_policy" || facts.scope === "unsupported")
    throw cdpOriginScopeRefusal("discover_webmcp_tools");
  if (observed.kind !== "observed")
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  if (facts.url === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return discoveryDocument(tree);
};

interface WebMcpIngestOptions {
  readonly event: CdpReceivedEvent;
  readonly input: DiscoverWebMcpToolsInput;
  readonly frames: ReadonlyMap<
    string,
    { readonly url: string; readonly origin: string | null }
  >;
  readonly tools: Map<string, WebMcpDiscovery["tools"]["items"][number]>;
  readonly completeness: CdpCaptureCompleteness;
  readonly transientFrames: Set<string>;
  readonly resolvedTransientFrames: Set<string>;
}

const ingestWebMcpEvent = (options: WebMcpIngestOptions): void => {
  const {
    event,
    input,
    frames,
    tools,
    completeness,
    transientFrames,
    resolvedTransientFrames,
  } = options;
  const registered = event.registered;
  if (
    registered?.method !== "WebMCP.toolsAdded" &&
    registered?.method !== "WebMCP.toolsRemoved"
  )
    return;
  const declared = webMcpEventTools(registered.payload.tools, completeness);
  if (registered.method === "WebMCP.toolsRemoved") {
    for (const removed of declared) {
      const name = cdpStringValue(removed.name);
      const frameId = cdpStringValue(removed.frameId);
      if (name === undefined || frameId === undefined) {
        completeness.exclude("webmcp_tools", "invalid_protocol_value");
        continue;
      }
      tools.delete(registrationKey(frameId, name));
    }
    return;
  }
  for (const tool of declared) {
    const frameId = cdpStringValue(tool.frameId);
    if (frameId !== undefined && transientFrames.has(frameId)) {
      if (!resolvedTransientFrames.has(frameId)) continue;
      transientFrames.delete(frameId);
      resolvedTransientFrames.delete(frameId);
    }
    const normalized = normalizeTool(tool, input, frames, completeness);
    if (normalized === undefined) continue;
    tools.set(
      registrationKey(normalized.frame_id, normalized.name),
      normalized,
    );
  }
};

/** Each malformed or missing inventory entry is a recorded gap, not an omission. */
const webMcpEventTools = (
  tools: readonly (UnknownRecord | undefined)[] | undefined,
  completeness: CdpCaptureCompleteness,
): UnknownRecord[] => {
  if (tools === undefined) {
    completeness.exclude("webmcp_tools", "invalid_protocol_value");
    return [];
  }
  const records: UnknownRecord[] = [];
  for (const record of tools) {
    if (record === undefined) {
      completeness.exclude("webmcp_tools", "invalid_protocol_value");
      continue;
    }
    records.push(record);
  }
  return records;
};

const normalizeTool = (
  value: UnknownRecord,
  input: DiscoverWebMcpToolsInput,
  frames: ReadonlyMap<
    string,
    { readonly url: string; readonly origin: string | null }
  >,
  completeness: CdpCaptureCompleteness,
): WebMcpDiscovery["tools"]["items"][number] | undefined => {
  const frameId = cdpStringValue(value.frameId);
  const name = cdpStringValue(value.name);
  const frame = frameId === undefined ? undefined : frames.get(frameId);
  if (frameId === undefined || name === undefined) {
    completeness.exclude("webmcp_tools", "invalid_protocol_value");
    return undefined;
  }
  if (frame?.origin === null || frame === undefined) {
    completeness.exclude("webmcp_tools", "out_of_target_scope");
    return undefined;
  }
  const description = cdpStringValue(value.description) ?? "";
  const annotations = recordValue(value.annotations);
  const malformedAnnotations =
    Object.hasOwn(value, "annotations") && annotations === undefined;
  if (malformedAnnotations)
    completeness.exclude("webmcp_tools", "invalid_protocol_value");
  const annotation = (key: string): boolean | null => {
    if (annotations === undefined || !Object.hasOwn(annotations, key))
      return null;
    const hint = annotations[key];
    if (typeof hint === "boolean") return hint;
    completeness.exclude("webmcp_tools", "invalid_protocol_value");
    return null;
  };
  const consequential = annotation("consequential");
  const unknownConsequential =
    malformedAnnotations ||
    (annotations !== undefined &&
      Object.hasOwn(annotations, "consequential") &&
      typeof annotations.consequential !== "boolean");
  const declaration = Object.hasOwn(value, "inputSchema")
    ? jsonValueSchema.safeParse(value.inputSchema)
    : undefined;
  if (declaration?.success === false)
    completeness.exclude("webmcp_tools", "invalid_protocol_value");
  const schema = declaration?.success === true ? declaration.data : null;
  const registrationFrame = topCallFrame(value.stackTrace);
  const coordinates = cdpSourceCoordinates(
    registrationFrame.ok ? registrationFrame.value : undefined,
  );
  if (!registrationFrame.ok || coordinates.invalid)
    completeness.exclude("webmcp_tools", "invalid_protocol_value");
  return {
    tool_key: toolKey(frame.url, frameId, name),
    name,
    description,
    frame_id: frameId,
    frame_url: frame.url,
    owner_origin: frame.origin,
    declaration_kind:
      numberValue(value.backendNodeId) === undefined
        ? "imperative"
        : "declarative",
    input_schema: schema,
    input_schema_sha256:
      declaration?.success === true ? digestCanonicalValue(schema) : null,
    annotations: {
      read_only: annotation("readOnly"),
      untrusted_content: annotation("untrustedContent"),
      ...(unknownConsequential ? {} : { consequential }),
      autosubmit: annotation("autosubmit"),
    },
    registration_source: registrationSource(
      registrationFrame.ok && !coordinates.invalid
        ? registrationFrame.value
        : undefined,
      new Set(input.allowed_origins),
    ),
    trust: "page-declared-untrusted",
  };
};

const registrationSource = (
  frame: UnknownRecord | undefined,
  allowedOrigins: ReadonlySet<string>,
): WebMcpDiscovery["tools"]["items"][number]["registration_source"] => {
  const url = allowedSanitizedUrl(frame?.url, allowedOrigins);
  const coordinates = cdpSourceCoordinates(frame);
  return frame === undefined || url === undefined
    ? null
    : {
        url: url.url,
        line: coordinates.line,
        column: coordinates.column,
      };
};

interface WebMcpResultOptions {
  readonly context: DiscoveryContext;
  readonly frameTree: CdpFrameTree;
  readonly tools: ReadonlyMap<
    string,
    WebMcpDiscovery["tools"]["items"][number]
  >;
  readonly completeness: CdpCaptureCompleteness;
  readonly limitations: string[];
  readonly available: boolean;
}

const buildWebMcpResult = (options: WebMcpResultOptions): WebMcpDiscovery => {
  const { context, frameTree, tools, completeness, limitations, available } =
    options;
  const targetUrl = observedFrameUrl(frameTree.root.url) ?? context.target.url;
  const sanitized = allowedSanitizedUrl(
    targetUrl,
    new Set(context.input.allowed_origins),
  );
  return {
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      url: sanitized?.url ?? "[unsupported-url]",
      origin: sanitized?.origin ?? "",
    },
    status: available ? "available" : "unavailable",
    tools: {
      total: tools.size + completeness.droppedTotal,
      items: [...tools.values()].sort((left, right) =>
        compareUnicodeCodePoints(left.tool_key, right.tool_key),
      ),
    },
    completeness: completeness.snapshot(),
    limitations,
  };
};

/**
 * A frame's registration is identified by its frame and tool name. The frame
 * URL in `tool_key` describes where it was registered, so a retained
 * registration and its later update after a URL change share one entry.
 */
const registrationKey = (frameId: string, name: string): string =>
  compositeKey([frameId, name]);

const toolKey = (frameUrl: string, frameId: string, name: string): string =>
  // Registrations without a known admitted frame are excluded above, so the
  // frame ID here always distinguishes owners. Composite tuple keeps a NUL
  // inside one field from collapsing two registrations before hashing.
  `webmcp_${sha256Hex(compositeKey([frameUrl, frameId, name]))}`;
