import type { WebPageInspection } from "../domain/browserObservation.js";
import {
  reconcileCapturedWebScript,
  stableWebScriptKey,
} from "../domain/webInventory.js";
import type { CapturedResource } from "./CdpCaptureDocuments.js";
import type { CdpCaptureEvents } from "./CdpCaptureEvents.js";
import type { CapturedScript } from "./CdpCaptureEventTypes.js";
import {
  requiredRecord,
  sourceExcluded,
  sourceResult,
  stringValue,
} from "./CdpCaptureValues.js";
import type { CaptureContext } from "./CdpPageCapture.js";
import type { WebSourceMapRequest } from "./WebSourceMapFetcher.js";

export interface CapturedScripts {
  readonly inventory: WebPageInspection["scripts"];
  readonly sourceMapRequests: readonly WebSourceMapRequest[];
}

export interface CaptureScriptsOptions {
  readonly context: CaptureContext;
  readonly events: CdpCaptureEvents;
  readonly rawResources: readonly CapturedResource[];
  readonly resources: WebPageInspection["resources"];
  readonly frameIds: ReadonlySet<string>;
}

interface ScriptDraftState {
  readonly context: CaptureContext;
  readonly events: CdpCaptureEvents;
  readonly frameIds: ReadonlySet<string>;
  readonly rawResources: readonly CapturedResource[];
  readonly resources: WebPageInspection["resources"];
  totalSourceBytes: number;
}

type ScriptDraftItem = Omit<
  WebPageInspection["scripts"]["items"][number],
  "script_key"
>;

export const captureScripts = async (
  options: CaptureScriptsOptions,
): Promise<CapturedScripts> => {
  const { context, events, rawResources, resources, frameIds } = options;
  const state: ScriptDraftState = {
    context,
    events,
    frameIds,
    rawResources,
    resources,
    totalSourceBytes: 0,
  };
  const drafts: {
    readonly item: ScriptDraftItem;
    readonly sourceMapRawUrl: string | null;
  }[] = [];
  for (const script of events.scripts.values())
    drafts.push(await buildScriptDraft(script, state));
  if (!context.input.include_script_sources)
    events.completeness.exclude(
      "script_sources",
      "not_approved",
      events.scripts.size,
    );
  return keyAndBuildInventory(drafts, events.scripts.size);
};

const buildScriptDraft = async (
  script: CapturedScript,
  state: ScriptDraftState,
): Promise<{
  readonly item: ScriptDraftItem;
  readonly sourceMapRawUrl: string | null;
}> => {
  let source: WebPageInspection["scripts"]["items"][number]["source"] = state
    .context.input.include_script_sources
    ? await captureScriptSource(script, state)
    : sourceExcluded("source capture was not approved");
  const inventoryScript = {
    frame_id: state.events.frameForScript(script, state.frameIds),
    url: script.url,
    cdp_hash: script.hash,
    length: script.length,
    is_module: script.isModule,
    language: script.language,
    source_map_url: script.sourceMapUrl,
  };
  return {
    item: {
      ...inventoryScript,
      origin: script.origin,
      resource_reconciliation: reconcileCapturedWebScript(
        { ...inventoryScript, rawUrl: script.rawUrl },
        state.rawResources,
        state.resources,
      ),
      source,
    },
    sourceMapRawUrl: script.sourceMapRawUrl,
  };
};

const captureScriptSource = async (
  script: CapturedScript,
  state: ScriptDraftState,
): Promise<WebPageInspection["scripts"]["items"][number]["source"]> => {
  const { context, events } = state;
  if (script.length > context.input.limits.max_script_source_bytes) {
    events.completeness.truncate("script_sources");
    return sourceExcluded("declared script length exceeds per-script limit");
  }
  if (
    state.totalSourceBytes + script.length >
    context.input.limits.max_total_script_source_bytes
  ) {
    events.completeness.truncate("script_sources");
    return sourceExcluded("total script source limit reached");
  }
  const result = requiredRecord(
    await context.connection.send(
      "Debugger.getScriptSource",
      { scriptId: script.scriptId },
      context.sessionId,
      context.signal,
    ),
  );
  const content = stringValue(result.scriptSource) ?? "";
  const bytes = Buffer.byteLength(content);
  if (
    bytes > context.input.limits.max_script_source_bytes ||
    state.totalSourceBytes + bytes >
      context.input.limits.max_total_script_source_bytes
  ) {
    events.completeness.truncate("script_sources");
    return sourceExcluded("actual source exceeds configured byte limits");
  }
  state.totalSourceBytes += bytes;
  return sourceResult(content);
};

const keyAndBuildInventory = (
  drafts: readonly {
    readonly item: ScriptDraftItem;
    readonly sourceMapRawUrl: string | null;
  }[],
  scriptCount: number,
): CapturedScripts => {
  const keyed = drafts.map((draft) => ({
    ...draft,
    base: stableWebScriptKey(draft.item),
  }));
  keyed.sort(
    (left, right) =>
      left.base.localeCompare(right.base) ||
      sourceDigest(left.item.source).localeCompare(
        sourceDigest(right.item.source),
      ) ||
      (left.item.frame_id ?? "").localeCompare(right.item.frame_id ?? ""),
  );
  const totals = new Map<string, number>();
  for (const { base } of keyed) totals.set(base, (totals.get(base) ?? 0) + 1);
  const seen = new Map<string, number>();
  const sourceMapRequests: WebSourceMapRequest[] = [];
  const items = keyed.map(({ base, item, sourceMapRawUrl }) => {
    const occurrence = (seen.get(base) ?? 0) + 1;
    seen.set(base, occurrence);
    const scriptKey =
      totals.get(base) === 1 ? base : `${base}_${String(occurrence)}`;
    if (item.source_map_url !== null && sourceMapRawUrl !== null)
      sourceMapRequests.push({
        scriptKey,
        declaredUrl: item.source_map_url,
        fetchUrl: sourceMapRawUrl,
      });
    return { script_key: scriptKey, ...item };
  });
  return {
    inventory: { total: scriptCount, items },
    sourceMapRequests,
  };
};

const sourceDigest = (
  source: WebPageInspection["scripts"]["items"][number]["source"],
): string => (source.included ? source.artifact.sha256 : source.reason);
