import { createHash } from "node:crypto";

import canonicalize from "canonicalize";

import type { ProgressReporter } from "../application/ProgressReporter.js";
import type {
  ElectronPageInspection,
  InspectElectronPageInput,
} from "../domain/electronObservation.js";
import { BrowserObservationError } from "../domain/errors.js";
import { createWebTextArtifact } from "../domain/webContentArtifact.js";
import type { CdpConnection, CdpEvent } from "./CdpConnection.js";
import type { CdpEndpointDiscovery, CdpEndpointTarget } from "./CdpEndpoint.js";
import { CdpCaptureCompleteness } from "./CdpCaptureCompleteness.js";
import {
  boundedText,
  delayWithCancellation,
  numberValue,
  recordValue,
  recordsValue,
  requiredRecord,
  stringValue,
  type UnknownRecord,
} from "./CdpCaptureValues.js";
import {
  authorizedElectronFile,
  canonicalElectronRoots,
} from "./ElectronFileScope.js";

interface ElectronContext {
  readonly connection: CdpConnection;
  readonly sessionId: string;
  readonly discovery: CdpEndpointDiscovery;
  readonly target: CdpEndpointTarget;
  readonly input: InspectElectronPageInput;
  readonly signal?: AbortSignal;
  readonly progress?: ProgressReporter;
}

interface ScriptDraft {
  readonly scriptId: string;
  readonly rawUrl: string;
  readonly hash: string;
  readonly length: number;
  readonly isModule: boolean;
  readonly language: string | null;
}

/** Passively inspect one root-confined Electron file page. */
export const inspectCdpElectronPage = async (
  context: ElectronContext,
): Promise<ElectronPageInspection> => {
  const roots = await canonicalElectronRoots(context.input.allowed_file_roots);
  const completeness = new CdpCaptureCompleteness();
  const scripts: ScriptDraft[] = [];
  let mainFrameId: string | undefined;
  let navigationDuringCapture = false;
  const removeListener = context.connection.onEvent((event) => {
    if (event.sessionId !== context.sessionId) return;
    ingestScript(event, scripts, completeness);
    if (mainFrameId !== undefined && navigatedFrameId(event) === mainFrameId)
      navigationDuringCapture = true;
  });
  const startedAt = new Date().toISOString();
  try {
    await report(context.progress, 1, "Authorizing Electron file frames");
    await context.connection.send(
      "Page.enable",
      {},
      context.sessionId,
      context.signal,
    );
    const before = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
    const frames = await captureFrames(
      before,
      roots,
      context.input.limits.max_frames,
      completeness,
    );
    const main = frames[0];
    if (main === undefined)
      throw new BrowserObservationError(
        "inspect_web_page",
        "target_not_allowed",
      );
    mainFrameId = main.frame_id;
    await context.connection.send(
      "Debugger.enable",
      { maxScriptsCacheSize: 4 * 1_024 * 1_024 },
      context.sessionId,
      context.signal,
    );
    await delayWithCancellation(context.input.observation_ms, context.signal);
    await report(context.progress, 2, "Capturing Electron structure");
    const resources = await captureResources(context, roots, completeness);
    const dom = await captureDom(context, roots, completeness);
    const normalizedScripts = await captureScripts(
      context,
      roots,
      scripts,
      completeness,
    );
    const after = await context.connection.send(
      "Page.getFrameTree",
      {},
      context.sessionId,
      context.signal,
    );
    const afterMain = await mainFilePath(after, roots);
    if (afterMain === undefined)
      throw new BrowserObservationError(
        "inspect_web_page",
        "target_not_allowed",
      );
    if (navigationDuringCapture || afterMain !== main.file_path)
      throw new BrowserObservationError("inspect_web_page", "target_changed");
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
      completeness: completeness.snapshot(),
      frames,
      dom,
      scripts: normalizedScripts,
      resources,
      limitations: [
        "Only canonical file paths contained by an approved root are retained.",
        "REA does not evaluate renderer JavaScript, invoke Electron APIs, navigate, click, or close the page.",
        "Script contents require separate source-capture approval and remain byte bounded.",
      ],
    };
  } finally {
    removeListener();
  }
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

const ingestScript = (
  event: CdpEvent,
  scripts: ScriptDraft[],
  completeness: CdpCaptureCompleteness,
): void => {
  if (event.method !== "Debugger.scriptParsed") return;
  const value = recordValue(event.params);
  const scriptId = stringValue(value?.scriptId);
  const rawUrl = stringValue(value?.url);
  if (scriptId === undefined || scriptId.length > 256) {
    completeness.exclude("scripts", "invalid_protocol_value");
    return;
  }
  if (rawUrl === undefined || rawUrl === "") {
    completeness.exclude("scripts", "unattributed_origin");
    return;
  }
  if (scripts.length >= 2_000) {
    completeness.drop("scripts");
    return;
  }
  scripts.push({
    scriptId,
    rawUrl,
    hash: (stringValue(value?.hash) ?? "").slice(0, 512),
    length: nonnegativeInteger(value?.length),
    isModule: value?.isModule === true,
    language: boundedText(value?.scriptLanguage, 100),
  });
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

const captureScripts = async (
  context: ElectronContext,
  roots: readonly string[],
  scripts: readonly ScriptDraft[],
  completeness: CdpCaptureCompleteness,
): Promise<ElectronPageInspection["scripts"]> => {
  let total = 0;
  let sourceBytes = 0;
  const items: ElectronPageInspection["scripts"]["items"] = [];
  const seen = new Set<string>();
  for (const script of scripts) {
    const path = await authorizedElectronFile(script.rawUrl, roots);
    if (path === undefined) {
      completeness.exclude("scripts", "out_of_target_scope");
      continue;
    }
    const identity = {
      file_path: path,
      cdp_hash: script.hash,
      length: script.length,
      is_module: script.isModule,
      language: script.language,
    };
    const scriptKey = `electron_script_${digest(identity)}`;
    if (seen.has(scriptKey)) continue;
    seen.add(scriptKey);
    total += 1;
    if (items.length >= context.input.limits.max_scripts) {
      completeness.drop("scripts");
      continue;
    }
    let source: ElectronPageInspection["scripts"]["items"][number]["source"] = {
      included: false,
      reason: "source capture was not approved",
    };
    if (context.input.include_script_sources) {
      if (
        script.length > context.input.limits.max_script_source_bytes ||
        sourceBytes + script.length >
          context.input.limits.max_total_script_source_bytes
      ) {
        source = {
          included: false,
          reason: "script source byte limit reached",
        };
        completeness.truncate("script_sources");
      } else {
        const result = requiredRecord(
          await context.connection.send(
            "Debugger.getScriptSource",
            { scriptId: script.scriptId },
            context.sessionId,
            context.signal,
          ),
        );
        const text = stringValue(result.scriptSource) ?? "";
        const bytes = Buffer.byteLength(text);
        if (
          bytes > context.input.limits.max_script_source_bytes ||
          sourceBytes + bytes >
            context.input.limits.max_total_script_source_bytes
        ) {
          source = {
            included: false,
            reason: "script source byte limit reached",
          };
          completeness.truncate("script_sources");
        } else {
          source = {
            included: true,
            artifact: createWebTextArtifact(text, "text/javascript"),
          };
          sourceBytes += bytes;
        }
      }
    }
    items.push({
      script_key: scriptKey,
      ...identity,
      source,
    });
  }
  if (!context.input.include_script_sources)
    completeness.exclude("script_sources", "not_approved", total);
  return {
    total,
    items: items.sort((left, right) =>
      left.script_key.localeCompare(right.script_key),
    ),
  };
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

const nonnegativeInteger = (value: unknown): number =>
  Math.max(0, integer(value, 0));

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
