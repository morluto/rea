import { createHash } from "node:crypto";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  DiscoverWebMcpToolsInput,
  WebMcpDiscovery,
} from "../domain/webMcpDiscovery.js";
import { inferJsonShape } from "../domain/jsonShape.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import { BrowserObservationError } from "../domain/errors.js";
import {
  allowedSanitizedUrl,
  delayWithCancellation,
  numberValue,
  recordValue,
  recordsValue,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import { captureFrames, mainFrameUrl } from "./CdpCaptureDocuments.js";
import { optionalCdpCommand } from "./CdpOptionalCommand.js";
import { boundedSensitiveText } from "./SensitiveTextCapture.js";

interface DiscoveryContext {
  readonly connection: CdpConnection;
  readonly sessionId: string;
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
  const initialUrl = mainFrameUrl(frameTree);
  if (allowedSanitizedUrl(initialUrl, origins) === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  const frames = captureFrames(frameTree, origins, 1_000, completeness).items;
  const frameUrls = new Map(
    frames.map((frame) => [
      frame.frame_id,
      {
        url: frame.url,
        origin: frame.origin,
        parentFrameId: frame.parent_frame_id,
      },
    ]),
  );
  const tools = new Map<string, WebMcpDiscovery["tools"]["items"][number]>();
  const frameScope = { origins, frames: frameUrls, tools, completeness };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    if (ingestFrameScopeEvent(event, frameScope)) return;
    ingestWebMcpEvent(event, context.input, frameUrls, tools, completeness);
  });
  await context.progress?.report({
    phase: "browser_observation",
    completed: 1,
    total: 2,
    message: "Enabling passive WebMCP discovery",
  });
  try {
    const enabled = await optionalCdpCommand(
      context,
      "WebMCP.enable",
      {},
      limitations,
    );
    const available = enabled !== undefined;
    if (!available) {
      completeness.unavailable("webmcp_tools");
    } else
      // CDP sends the enable response before the required toolsAdded replay.
      await delayWithCancellation(
        Math.max(context.input.observation_ms, 25),
        context.signal,
      );
    await assertStableAuthorizedFrame(context, initialUrl, origins);
    return result(
      context,
      frameTree,
      tools,
      completeness,
      limitations,
      available,
    );
  } finally {
    removeListener();
    await context.progress?.report({
      phase: "browser_observation",
      completed: 2,
      total: 2,
      message: "WebMCP discovery complete",
      terminal: true,
    });
  }
};

interface FrameScopeState {
  readonly origins: ReadonlySet<string>;
  readonly frames: Map<string, FrameScopeFrame>;
  readonly tools: Map<string, WebMcpDiscovery["tools"]["items"][number]>;
  readonly completeness: CdpCaptureCompleteness;
}

interface FrameScopeFrame {
  readonly url: string;
  readonly origin: string | null;
  readonly parentFrameId: string | null;
}

const ingestFrameScopeEvent = (
  event: CdpEvent,
  state: FrameScopeState,
): boolean => {
  const params = recordValue(event.params);
  if (params === undefined) return false;
  if (event.method === "Page.frameDetached") {
    const frameId = stringValue(params.frameId);
    if (frameId === undefined || frameId.length > 256)
      state.completeness.exclude("webmcp_tools", "invalid_protocol_value");
    else removeFrame(frameId, state.frames, state.tools);
    return true;
  }
  const frame =
    event.method === "Page.frameNavigated" ? recordValue(params.frame) : params;
  if (
    event.method !== "Page.frameNavigated" &&
    event.method !== "Page.navigatedWithinDocument"
  )
    return false;
  const frameId = stringValue(frame?.id) ?? stringValue(frame?.frameId);
  if (frameId === undefined || frameId.length > 256) {
    state.completeness.exclude("webmcp_tools", "invalid_protocol_value");
    return true;
  }
  const url = allowedSanitizedUrl(frame?.url, state.origins);
  if (url === undefined || url.origin === null) {
    removeFrame(frameId, state.frames, state.tools);
    state.completeness.exclude("webmcp_tools", "out_of_target_scope");
    return true;
  }
  state.frames.set(frameId, {
    url: url.url,
    origin: url.origin,
    parentFrameId:
      (stringValue(frame?.parentId) ??
        state.frames.get(frameId)?.parentFrameId ??
        "") ||
      null,
  });
  return true;
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

const assertStableAuthorizedFrame = async (
  context: DiscoveryContext,
  initialUrl: string | undefined,
  origins: ReadonlySet<string>,
): Promise<void> => {
  const finalTree = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const finalUrl = mainFrameUrl(finalTree);
  if (allowedSanitizedUrl(finalUrl, origins) === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (finalUrl !== initialUrl)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
};

const ingestWebMcpEvent = (
  event: CdpEvent,
  input: DiscoverWebMcpToolsInput,
  frames: ReadonlyMap<
    string,
    { readonly url: string; readonly origin: string | null }
  >,
  tools: Map<string, WebMcpDiscovery["tools"]["items"][number]>,
  completeness: CdpCaptureCompleteness,
): void => {
  const params = recordValue(event.params);
  if (params === undefined) return;
  if (event.method === "WebMCP.toolsRemoved") {
    for (const removed of recordsValue(params.tools)) {
      const name = stringValue(removed.name);
      const frameId = stringValue(removed.frameId);
      if (name === undefined || frameId === undefined) continue;
      for (const [key, tool] of tools)
        if (tool.name === name && tool.frame_id === frameId) tools.delete(key);
    }
    return;
  }
  if (event.method !== "WebMCP.toolsAdded") return;
  for (const declared of recordsValue(params.tools)) {
    const normalized = normalizeTool(declared, input, frames, completeness);
    if (normalized === undefined) continue;
    if (!tools.has(normalized.tool_key) && tools.size >= input.max_tools) {
      completeness.drop("webmcp_tools");
      continue;
    }
    tools.set(normalized.tool_key, normalized);
  }
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
  const frameId = stringValue(value.frameId);
  const name = stringValue(value.name);
  const frame = frameId === undefined ? undefined : frames.get(frameId);
  if (
    frameId === undefined ||
    name === undefined ||
    frame?.origin === null ||
    frame === undefined
  ) {
    completeness.exclude("webmcp_tools", "out_of_target_scope");
    return undefined;
  }
  const description = boundedSensitiveText(
    stringValue(value.description) ?? "",
    4_096,
  ).text;
  const annotations = recordValue(value.annotations);
  return {
    tool_key: toolKey(frame.url, name),
    name: boundedSensitiveText(name, 512).text,
    description,
    frame_id: frameId.slice(0, 256),
    frame_url: frame.url,
    owner_origin: frame.origin,
    declaration_kind:
      numberValue(value.backendNodeId) === undefined
        ? "imperative"
        : "declarative",
    input_schema_shape: schemaShape(value.inputSchema, input, completeness),
    annotations: {
      read_only: booleanOrNull(annotations?.readOnly),
      untrusted_content: booleanOrNull(annotations?.untrustedContent),
      autosubmit: booleanOrNull(annotations?.autosubmit),
    },
    registration_source: registrationSource(
      recordValue(value.stackTrace),
      new Set(input.allowed_origins),
    ),
    trust: "page-declared-untrusted",
  };
};

const schemaShape = (
  value: unknown,
  input: DiscoverWebMcpToolsInput,
  completeness: CdpCaptureCompleteness,
) => {
  if (recordValue(value) === undefined) return null;
  const encoded = JSON.stringify(value);
  const shape = inferJsonShape(encoded, {
    maximumBytes: input.max_schema_bytes,
    maximumNodes: input.max_schema_nodes,
    maximumDepth: input.max_schema_depth,
  });
  if (shape === null || shape.truncated) completeness.truncate("webmcp_tools");
  return shape;
};

const registrationSource = (
  stack: UnknownRecord | undefined,
  allowedOrigins: ReadonlySet<string>,
): WebMcpDiscovery["tools"]["items"][number]["registration_source"] => {
  const frame = recordsValue(stack?.callFrames)[0];
  const url = allowedSanitizedUrl(frame?.url, allowedOrigins);
  return frame === undefined || url === undefined
    ? null
    : {
        url: url.url,
        line: integerOrNull(frame.lineNumber),
        column: integerOrNull(frame.columnNumber),
      };
};

const result = (
  context: DiscoveryContext,
  frameTree: unknown,
  tools: ReadonlyMap<string, WebMcpDiscovery["tools"]["items"][number]>,
  completeness: CdpCaptureCompleteness,
  limitations: string[],
  available: boolean,
): WebMcpDiscovery => {
  const targetUrl = mainFrameUrl(frameTree) ?? context.target.url;
  const sanitized = allowedSanitizedUrl(
    targetUrl,
    new Set(context.input.allowed_origins),
  );
  return {
    schema_version: 1,
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
        left.tool_key.localeCompare(right.tool_key),
      ),
    },
    completeness: completeness.snapshot(),
    limitations,
  };
};

const toolKey = (frameUrl: string, name: string): string =>
  `webmcp_${createHash("sha256").update(`${frameUrl}\0${name}`).digest("hex")}`;

const booleanOrNull = (value: unknown): boolean | null =>
  typeof value === "boolean" ? value : null;

const integerOrNull = (value: unknown): number | null => {
  const number = numberValue(value);
  return number === undefined ? null : Math.max(0, Math.trunc(number));
};
