import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/electronObservation.js";
import { BrowserObservationError } from "../domain/errors.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  delayWithCancellation,
  numberValue,
  recordValue,
  recordsValue,
  requiredRecord,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import {
  ingestElectronScriptEvent,
  type ElectronScriptDraft,
} from "./CdpElectronScriptEvents.js";
import { captureElectronScripts } from "./CdpElectronScripts.js";
import { captureElectronWorkers } from "./CdpElectronWorkers.js";
import {
  authorizedElectronFile,
  canonicalElectronRoots,
} from "./ElectronFileScope.js";

interface ElectronContext {
  readonly connection: CdpConnection;
  readonly sessionId: string | undefined;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: InspectElectronPageInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

interface ElectronInspectionState {
  readonly roots: readonly string[];
  readonly completeness: CdpCaptureCompleteness;
  readonly scripts: ElectronScriptDraft[];
  readonly executionContextFrames: Map<string, string>;
  readonly limitations: string[];
  mainFrameId: string | undefined;
  navigationDuringCapture: boolean;
}

/** Passively inspect one root-confined Electron file page. */
export const inspectCdpElectronPage = async (
  context: ElectronContext,
): Promise<ElectronPageInspection> => {
  const state: ElectronInspectionState = {
    roots: await canonicalElectronRoots(context.input.allowed_file_roots),
    completeness: new CdpCaptureCompleteness(),
    scripts: [],
    executionContextFrames: new Map(),
    limitations: [
      "Only canonical file paths contained by an approved root are retained.",
      "REA does not evaluate renderer JavaScript, invoke Electron APIs, navigate, click, or close the page.",
      "Script contents require separate source-capture approval and remain byte bounded.",
    ],
    mainFrameId: undefined,
    navigationDuringCapture: false,
  };
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    ingestElectronScriptEvent({
      event,
      scripts: state.scripts,
      executionContextFrames: state.executionContextFrames,
      completeness: state.completeness,
    });
    if (
      state.mainFrameId !== undefined &&
      navigatedFrameId(event) === state.mainFrameId
    )
      state.navigationDuringCapture = true;
  });
  try {
    return await runElectronInspection(
      context,
      state,
      new Date().toISOString(),
    );
  } finally {
    removeListener();
  }
};

const runElectronInspection = async (
  context: ElectronContext,
  state: ElectronInspectionState,
  startedAt: string,
): Promise<ElectronPageInspection> => {
  const frames = await authorizeInitialFrames(context, state);
  const main = frames[0]!;
  state.mainFrameId = main.frame_id;
  await enableElectronCapture(context);
  await delayWithCancellation(
    context.input.observation_ms,
    "inspect_electron_page",
    context.signal,
  );
  const captured = await captureElectronContent(context, state, frames);
  await assertStableMainFrame(context, state, main.file_path);
  await report(context.progress, 3, "Electron inspection complete");
  return {
    schema_version: 1,
    browser: context.discovery.version,
    target: {
      target_id: context.target.id,
      type: context.target.type,
      title: context.target.title.slice(0, 16_384),
      file_path: main.file_path,
      attached: context.target.attached,
    },
    capture_window: {
      started_at: startedAt,
      ended_at: new Date().toISOString(),
      observation_ms: context.input.observation_ms,
    },
    completeness: state.completeness.snapshot(),
    frames,
    ...captured,
    limitations: state.limitations,
  };
};

const authorizeInitialFrames = async (
  context: ElectronContext,
  state: ElectronInspectionState,
): Promise<ElectronPageInspection["frames"]> => {
  await report(context.progress, 1, "Authorizing Electron file frames");
  await context.connection.send(
    "Page.enable",
    {},
    context.sessionId,
    context.signal,
  );
  const result = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const frames = await captureFrames(
    result,
    state.roots,
    context.input.limits.max_frames,
    state.completeness,
  );
  if (frames[0] === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  return frames;
};

const enableElectronCapture = async (
  context: ElectronContext,
): Promise<void> => {
  await context.connection.send(
    "Runtime.enable",
    {},
    context.sessionId,
    context.signal,
  );
  await context.connection.send(
    "Debugger.enable",
    { maxScriptsCacheSize: 4 * 1_024 * 1_024 },
    context.sessionId,
    context.signal,
  );
};

const captureElectronContent = async (
  context: ElectronContext,
  state: ElectronInspectionState,
  frames: ElectronPageInspection["frames"],
): Promise<
  Pick<ElectronPageInspection, "dom" | "scripts" | "resources" | "workers">
> => {
  await report(context.progress, 2, "Capturing Electron structure");
  const frameIds = new Set(frames.map((frame) => frame.frame_id));
  const resources = await captureResources(
    context,
    state.roots,
    state.completeness,
  );
  const dom = await captureDom(context, state.roots, state.completeness);
  const scripts = await captureElectronScripts({
    connection: context.connection,
    sessionId: context.sessionId,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    request: context.input,
    roots: state.roots,
    scripts: state.scripts,
    executionContextFrames: state.executionContextFrames,
    frameIds,
    completeness: state.completeness,
  });
  const workers = await captureElectronWorkers({
    connection: context.connection,
    ...(context.signal === undefined ? {} : { signal: context.signal }),
    target: context.target,
    request: context.input,
    roots: state.roots,
    frameIds,
    completeness: state.completeness,
    limitations: state.limitations,
  });
  return { dom, scripts, resources, workers };
};

const assertStableMainFrame = async (
  context: ElectronContext,
  state: ElectronInspectionState,
  expectedPath: string,
): Promise<void> => {
  const result = await context.connection.send(
    "Page.getFrameTree",
    {},
    context.sessionId,
    context.signal,
  );
  const afterPath = await mainFilePath(result, state.roots);
  if (afterPath === undefined)
    throw new BrowserObservationError("inspect_web_page", "target_not_allowed");
  if (state.navigationDuringCapture || afterPath !== expectedPath)
    throw new BrowserObservationError("inspect_web_page", "target_changed");
};

const navigatedFrameId = (event: CdpEvent): string | undefined => {
  const params = recordValue(event.params);
  if (params === undefined) return undefined;
  if (event.method === "Page.frameNavigated")
    return stringValue(recordValue(params.frame)?.id);
  if (event.method === "Page.navigatedWithinDocument")
    return stringValue(params.frameId);
  return undefined;
};

const captureFrames = async (
  result: unknown,
  roots: readonly string[],
  maximum: number,
  completeness: CdpCaptureCompleteness,
): Promise<ElectronPageInspection["frames"]> => {
  const frameTree = recordValue(requiredRecord(result).frameTree);
  if (frameTree === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const pending: Array<{
    readonly tree: UnknownRecord;
    readonly parent: string | null;
  }> = [{ tree: frameTree, parent: null }];
  const frames: ElectronPageInspection["frames"] = [];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current === undefined) break;
    const frame = recordValue(current.tree.frame);
    const frameId = stringValue(frame?.id);
    const path = await authorizedElectronFile(
      stringValue(frame?.url) ?? "",
      roots,
    );
    if (frameId === undefined || path === undefined) {
      completeness.exclude("frames", "out_of_target_scope");
      continue;
    }
    if (frames.length >= maximum) {
      completeness.truncate("frames");
      continue;
    }
    frames.push({
      frame_id: frameId.slice(0, 256),
      parent_frame_id: current.parent,
      file_path: path,
    });
    for (const child of recordsValue(current.tree.childFrames))
      pending.push({ tree: child, parent: frameId.slice(0, 256) });
  }
  return frames;
};

const captureResources = async (
  context: ElectronContext,
  roots: readonly string[],
  completeness: CdpCaptureCompleteness,
): Promise<ElectronPageInspection["resources"]> => {
  const result = await context.connection.send(
    "Page.getResourceTree",
    {},
    context.sessionId,
    context.signal,
  );
  const root = recordValue(requiredRecord(result).frameTree);
  if (root === undefined)
    throw new BrowserObservationError("inspect_web_page", "protocol_error");
  const pending = [root];
  const resources: ElectronPageInspection["resources"] = [];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const tree = pending.shift();
    if (tree === undefined) break;
    for (const resource of recordsValue(tree.resources)) {
      const path = await authorizedElectronFile(
        stringValue(resource.url) ?? "",
        roots,
      );
      if (path === undefined) {
        completeness.exclude("resources", "out_of_target_scope");
        continue;
      }
      const item = {
        file_path: path,
        type: (stringValue(resource.type) ?? "Other").slice(0, 100),
        mime_type: (stringValue(resource.mimeType) ?? "").slice(0, 256),
        content_size:
          numberValue(resource.contentSize) === undefined
            ? null
            : Math.max(0, numberValue(resource.contentSize) ?? 0),
      };
      const resourceKey = `electron_resource_${digest(item)}`;
      if (seen.has(resourceKey)) continue;
      seen.add(resourceKey);
      if (resources.length >= context.input.limits.max_resources) {
        completeness.truncate("resources");
        continue;
      }
      resources.push({
        resource_key: resourceKey,
        ...item,
      });
    }
    pending.push(...recordsValue(tree.childFrames));
  }
  return resources.sort((left, right) =>
    left.resource_key.localeCompare(right.resource_key),
  );
};

const captureDom = async (
  context: ElectronContext,
  roots: readonly string[],
  completeness: CdpCaptureCompleteness,
): Promise<ElectronPageInspection["dom"]> => {
  const result = requiredRecord(
    await context.connection.send(
      "DOMSnapshot.captureSnapshot",
      { computedStyles: [], includePaintOrder: false, includeDOMRects: false },
      context.sessionId,
      context.signal,
    ),
  );
  const strings = Array.isArray(result.strings)
    ? result.strings.map((value) => (typeof value === "string" ? value : ""))
    : [];
  const nodes: ElectronPageInspection["dom"]["nodes"] = [];
  let total = 0;
  for (const document of recordsValue(result.documents)) {
    const documentUrl = stringAt(strings, document.documentURL);
    if ((await authorizedElectronFile(documentUrl, roots)) === undefined) {
      completeness.exclude("dom", "out_of_target_scope");
      continue;
    }
    const nodeData = recordValue(document.nodes);
    const nodeTypes = arrayValue(nodeData?.nodeType);
    const nodeNames = arrayValue(nodeData?.nodeName);
    const nodeValues = arrayValue(nodeData?.nodeValue);
    const parents = arrayValue(nodeData?.parentIndex);
    const attributes = arrayValue(nodeData?.attributes);
    const baseIndex = nodes.length;
    total += nodeTypes.length;
    for (let index = 0; index < nodeTypes.length; index += 1) {
      if (nodes.length >= context.input.limits.max_dom_nodes) continue;
      const attributeIndexes = arrayValue(attributes[index]);
      const parent = integer(parents[index], -1);
      nodes.push({
        index: nodes.length,
        parent_index: parent < 0 ? -1 : baseIndex + parent,
        node_type: integer(nodeTypes[index], 0),
        node_name: stringAt(strings, nodeNames[index]).slice(0, 1_024),
        node_value_length: Buffer.byteLength(
          stringAt(strings, nodeValues[index]),
        ),
        attribute_names: attributeIndexes
          .filter((_value, attributeIndex) => attributeIndex % 2 === 0)
          .map((value) => stringAt(strings, value).slice(0, 1_024))
          .slice(0, 256),
      });
    }
  }
  if (total > nodes.length) completeness.truncate("dom");
  return { total_nodes: total, nodes };
};

const mainFilePath = async (
  result: unknown,
  roots: readonly string[],
): Promise<string | undefined> => {
  const frameTree = recordValue(requiredRecord(result).frameTree);
  const frame = recordValue(frameTree?.frame);
  return await authorizedElectronFile(stringValue(frame?.url) ?? "", roots);
};

const arrayValue = (value: unknown): readonly unknown[] =>
  Array.isArray(value) ? value : [];

const stringAt = (strings: readonly string[], value: unknown): string =>
  strings[integer(value, -1)] ?? "";

const integer = (value: unknown, fallback: number): number => {
  const number = numberValue(value);
  return number === undefined ? fallback : Math.trunc(number);
};

const digest = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined) throw new TypeError("Expected canonical JSON");
  return createHash("sha256").update(encoded).digest("hex");
};

const report = async (
  progress: ProgressReporter | undefined,
  completed: number,
  message: string,
): Promise<void> =>
  await progress?.report({
    phase: "browser_observation",
    completed,
    total: 3,
    message,
    ...(completed === 3 ? { terminal: true } : {}),
  });
