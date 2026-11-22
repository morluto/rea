import { isPossibleCachedDataCompilation } from "../../domain/javascript/electronDynamicCodeFacts.js";
import type { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { ElectronIpcFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import type { ElectronBoundarySummary } from "../../domain/javascript/javascriptApplicationAnalysis.js";
import type {
  AnalyzedJavaScriptArtifactFile,
  JavaScriptArtifactAnalysis,
} from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "../../domain/javascript/javascriptArtifactFiles.js";
import {
  resolveArtifactPathByContext,
  type ResolveArtifactPathInput,
} from "./JavaScriptArtifactPathResolution.js";

/** One IPC fact retaining its exact owning artifact for graph projection. */
export interface ElectronIpcRecord {
  readonly key: string;
  readonly file: JavaScriptArtifactFile;
  readonly finding: ElectronIpcFinding;
}

/** An unambiguous literal renderer-to-main static pairing. */
export interface ElectronIpcPairing {
  readonly transmission: ElectronIpcRecord;
  readonly handler: ElectronIpcRecord;
}

/** Pairing state for one renderer transmission without overclaiming ambiguity. */
export interface ElectronIpcPairingState {
  readonly transmission: ElectronIpcRecord;
  readonly candidates: readonly ElectronIpcRecord[];
  readonly status: "paired" | "ambiguous" | "unpaired";
  /** An observed match that may have unseen competitors when coverage is incomplete. */
  readonly coverageLimitedCandidate: ElectronIpcRecord | null;
}

/** Flatten all per-file IPC facts into deterministic application records. */
export const collectElectronIpcRecords = (
  analysis: JavaScriptArtifactAnalysis,
): readonly ElectronIpcRecord[] =>
  analysis.files
    .flatMap(({ file, javascript }) =>
      (javascript?.electron.ipc ?? []).map((finding) => ({
        key: ipcRecordKey(file.path, finding),
        file,
        finding,
      })),
    )
    .sort((left, right) => compareUnicodeCodePoints(left.key, right.key));

/** One interpretation shared by summary and every graph pairing consumer. */
export interface ElectronIpcContext {
  readonly records: readonly ElectronIpcRecord[];
  readonly owners: ReadonlyMap<string, string | null>;
  readonly states: readonly ElectronIpcPairingState[];
  readonly pairings: readonly ElectronIpcPairing[];
}

/** Equal channel text only establishes a pairing within one proven application owner. */
export const createElectronIpcContext = (
  analysis: JavaScriptArtifactAnalysis,
  applicationOwner: (file: JavaScriptArtifactFile) => string | null,
  coverageComplete: boolean,
): ElectronIpcContext => {
  const records = collectElectronIpcRecords(analysis);
  const owners = new Map(
    records.map((record) => [record.key, applicationOwner(record.file)]),
  );
  const handlerIndex = indexMainHandlers(records);
  const states: ElectronIpcPairingState[] = records
    .filter(isPairableRendererTransmission)
    .map((transmission) => {
      const owner = owners.get(transmission.key);
      const matching = matchingMainHandlers(handlerIndex, transmission.finding);
      const candidates: ElectronIpcRecord[] = [];
      let hasCandidateAuthority = false;
      let hasUnknownOwner = false;
      for (const handler of matching) {
        const handlerOwner = owners.get(handler.key);
        if (handlerOwner === owner) candidates.push(handler);
        if (handler.finding.loader_authority === "candidate")
          hasCandidateAuthority = true;
        if (handlerOwner == null) hasUnknownOwner = true;
      }
      // Unknown ownership can conceal competing dispatch contexts. Different owners
      // do not prove runtime isolation, so retain ambiguity rather than absence.
      const uncertain =
        !coverageComplete ||
        owner == null ||
        transmission.finding.loader_authority === "candidate" ||
        hasCandidateAuthority ||
        hasUnknownOwner;
      return {
        transmission,
        candidates,
        coverageLimitedCandidate:
          !coverageComplete &&
          transmission.finding.loader_authority !== "candidate" &&
          owner != null &&
          candidates.length === 1 &&
          candidates[0]?.finding.loader_authority !== "candidate" &&
          isExactIpcHandler(candidates[0]) &&
          !hasUnknownOwner
            ? (candidates[0] ?? null)
            : null,
        status:
          !uncertain &&
          candidates.length === 1 &&
          isExactIpcHandler(candidates[0])
            ? "paired"
            : uncertain || matching.length > 0
              ? "ambiguous"
              : "unpaired",
      };
    });
  const pairings = states.flatMap((state) => {
    const handler = state.candidates[0];
    return state.status === "paired" && handler !== undefined
      ? [{ transmission: state.transmission, handler }]
      : [];
  });
  return { records, owners, states, pairings };
};

interface MainHandlerIndex {
  readonly exactByChannel: ReadonlyMap<string, readonly ElectronIpcRecord[]>;
  readonly guardedByChannel: ReadonlyMap<string, readonly ElectronIpcRecord[]>;
  readonly wildcardDynamic: readonly ElectronIpcRecord[];
}

const pushRecordBucket = (
  map: Map<string, ElectronIpcRecord[]>,
  key: string,
  record: ElectronIpcRecord,
): void => {
  const bucket = map.get(key);
  if (bucket === undefined) map.set(key, [record]);
  else bucket.push(record);
};

/**
 * Index main handlers by literal channel, guarded literal invocation channels,
 * or wildcard dynamic receivers. An unresolved channel may receive any literal
 * channel, so it competes without ever pairing; a wrapper site whose
 * invocations all supplied literal channels is represented by their findings,
 * except guarded invocations, which still compete for their own channels.
 */
const indexMainHandlers = (
  records: readonly ElectronIpcRecord[],
): MainHandlerIndex => {
  const exactByChannel = new Map<string, ElectronIpcRecord[]>();
  const guardedByChannel = new Map<string, ElectronIpcRecord[]>();
  const wildcardDynamic: ElectronIpcRecord[] = [];
  for (const record of records) {
    if (!isMainHandler(record)) continue;
    const { finding } = record;
    if (finding.channel !== null) {
      pushRecordBucket(exactByChannel, finding.channel, record);
      continue;
    }
    if (
      finding.receiver === undefined &&
      finding.invocation_channels === "literal"
    ) {
      for (const channel of new Set(finding.guarded_invocation_channels ?? []))
        pushRecordBucket(guardedByChannel, channel, record);
      continue;
    }
    wildcardDynamic.push(record);
  }
  return { exactByChannel, guardedByChannel, wildcardDynamic };
};

const matchingMainHandlers = (
  index: MainHandlerIndex,
  transmission: ElectronIpcFinding,
): ElectronIpcRecord[] => {
  const channel = transmission.channel;
  if (channel === null) return [];
  const exact = index.exactByChannel.get(channel);
  const guarded = index.guardedByChannel.get(channel);
  const wildcard = index.wildcardDynamic;
  const matching: ElectronIpcRecord[] = [];
  let buckets = 0;
  for (const list of [exact, guarded, wildcard]) {
    if (list === undefined || list.length === 0) continue;
    let addedFromList = false;
    for (const handler of list) {
      if (!compatibleIpcModes(transmission, handler.finding)) continue;
      matching.push(handler);
      addedFromList = true;
    }
    if (addedFromList) buckets += 1;
  }
  // Each individual bucket preserves `records` order; sort only when merging multiple buckets.
  if (buckets > 1)
    matching.sort((left, right) =>
      compareUnicodeCodePoints(left.key, right.key),
    );
  return matching;
};

/**
 * Whether one analyzed source loads an Electron module.
 *
 * `analysis_coverage.applicability.electron` is the domain owner of this
 * question: it already excludes a `type-import`, a `require.resolve` that only
 * locates the module, a `worker` URL path, and a specifier that is a recovered
 * bundle module key. Reading the owned fact here keeps the boundary summary and
 * the published coverage view from disagreeing.
 */
const electronModuleReferencedBy = ({
  javascript,
}: AnalyzedJavaScriptArtifactFile): boolean =>
  javascript?.analysis_coverage.applicability.electron === "observed";

/** Whether any analyzed source loads an Electron module. */
const electronModuleReferenced = (
  analysis: JavaScriptArtifactAnalysis,
): boolean => analysis.files.some(electronModuleReferencedBy);

const countWhere = <T>(
  items: readonly T[],
  predicate: (item: T) => boolean,
): number => {
  let count = 0;
  for (const item of items) if (predicate(item)) count++;
  return count;
};

/**
 * Every Electron boundary fact family the graph reports. A rejected
 * application projection keeps its static facts on the file node only, so
 * those facts are not part of the reported boundary surface.
 */
export const electronBoundaryFactCount = (
  analysis: JavaScriptArtifactAnalysis,
): number =>
  analysis.files.reduce(
    (count, { javascript, application_projection_failure }) =>
      count +
      (javascript === null || application_projection_failure !== undefined
        ? 0
        : countWhere(
            javascript.electron.browser_windows,
            provenElectronFinding,
          ) +
          countWhere(
            javascript.electron.context_bridge_apis,
            provenElectronFinding,
          ) +
          countWhere(javascript.electron.ipc, provenElectronFinding) +
          countWhere(
            javascript.electron.sender_validations,
            provenElectronFinding,
          ) +
          countWhere(
            javascript.electron.utility_processes,
            provenElectronFinding,
          ) +
          countWhere(
            javascript.electron.native_addon_bindings,
            provenElectronFinding,
          ) +
          countWhere(javascript.electron.protocols, provenElectronFinding) +
          countWhere(
            javascript.electron.dynamic_code ?? [],
            isPossibleCachedDataCompilation,
          )),
    0,
  );

const provenElectronFinding = (finding: {
  readonly loader_authority?: "candidate" | undefined;
}): boolean => finding.loader_authority !== "candidate";

/** Candidate findings remain in the graph, but are not proven summary counts. */
export const hasCandidateElectronFindings = (
  analysis: JavaScriptArtifactAnalysis,
): boolean =>
  analysis.files.some(
    ({ javascript }) =>
      javascript !== null &&
      [
        javascript.electron.browser_windows,
        javascript.electron.context_bridge_apis,
        javascript.electron.ipc,
        javascript.electron.sender_validations,
        javascript.electron.utility_processes,
        javascript.electron.native_addon_bindings,
        javascript.electron.protocols,
        javascript.electron.app_path_changes ?? [],
        javascript.electron.call_paths ?? [],
      ].some((findings) =>
        findings.some((finding) => !provenElectronFinding(finding)),
      ),
  );

/**
 * A completed static pass can still stop early, for example at the Electron
 * wrapper expansion budget. Syntax recovery and examination facts jointly own that verdict.
 */
const electronExaminationLimited = ({
  javascript,
}: AnalyzedJavaScriptArtifactFile): boolean => {
  if (javascript === null) return false;
  const { examination, syntax } = javascript.analysis_coverage;
  return (
    javascript.parse_status !== "complete" ||
    syntax.status !== "complete" ||
    examination.status !== "complete"
  );
};

/**
 * Electron-loading sources whose boundary facts may be missing from the
 * report: their analysis was interrupted or not started, their application
 * projection was rejected for the result budget, or their static examination
 * stopped at a resource limit or retained only partial syntax/semantics.
 */
export const electronIncompleteSourceCount = (
  analysis: JavaScriptArtifactAnalysis,
): number =>
  analysis.files.filter(
    (file) =>
      (file.analysis_failure !== undefined ||
        file.application_projection_failure !== undefined ||
        electronExaminationLimited(file)) &&
      electronModuleReferencedBy(file),
  ).length;

/**
 * Whether the Electron boundary summary came back empty or incomplete.
 * `undefined` means no analyzed source names Electron, which is unknown rather
 * than absent: unread sources and dynamic module names can hide its use.
 * `partial` means some facts were reported while other Electron-loading
 * sources were not fully examined or reported, so missing windows, preloads,
 * bridges, or IPC operations from those sources are unknown.
 */
export const electronSemanticsState = (
  analysis: JavaScriptArtifactAnalysis,
): "recovered" | "partial" | "empty" | undefined =>
  electronModuleReferenced(analysis) === false
    ? undefined
    : electronBoundaryFactCount(analysis) === 0
      ? "empty"
      : electronIncompleteSourceCount(analysis) > 0
        ? "partial"
        : "recovered";

/** Summarize static Electron findings without treating gaps as absence. */
export const summarizeElectronBoundaries = (
  analysis: JavaScriptArtifactAnalysis,
  ipcContext: ElectronIpcContext,
  directoryPaths?: ReadonlySet<string>,
  /**
   * Analysis view used only to describe coverage. A rejected application
   * projection replaces a file with a placeholder in `analysis`, which would
   * hide a retained Electron reference, so the caller passes the raw analysis
   * and both outputs then share one coverage result.
   */
  coverageAnalysis: JavaScriptArtifactAnalysis = analysis,
): ElectronBoundarySummary => {
  const files = new Map<string, JavaScriptArtifactFile>();
  for (const { file } of analysis.files) files.set(file.path, file);

  let browserWindows = 0;
  let explicitWebPreferences = 0;
  let preloadEntrypoints = 0;
  let contextBridgeApis = 0;
  let exposedApiMembers = 0;
  let senderValidationObservations = 0;
  let protocolCount = 0;
  let utilityProcesses = 0;
  let resolvedUtilityEntrypoints = 0;
  let nativeAddonBindings = 0;
  let resolvedNativeAddonBindings = 0;
  let v8CachedDataCompilations = 0;

  for (const { file, javascript: value } of analysis.files) {
    if (value === null) continue;
    const { electron } = value;
    for (const window of electron.browser_windows) {
      if (!provenElectronFinding(window)) continue;
      browserWindows += 1;
      explicitWebPreferences += window.web_preferences.length;
      if (window.preload_path !== null) preloadEntrypoints += 1;
    }
    for (const bridge of electron.context_bridge_apis) {
      if (!provenElectronFinding(bridge)) continue;
      contextBridgeApis += 1;
      exposedApiMembers += bridge.members.length;
    }
    for (const validation of electron.sender_validations) {
      if (provenElectronFinding(validation)) senderValidationObservations += 1;
    }
    for (const protocol of electron.protocols) {
      if (provenElectronFinding(protocol)) protocolCount += 1;
    }
    for (const finding of electron.utility_processes) {
      if (!provenElectronFinding(finding)) continue;
      utilityProcesses += 1;
      if (
        finding.module_path !== null &&
        resolvesToFile({
          file,
          specifier: finding.module_path,
          context: finding.module_resolution_context,
          files,
          jsonDocuments: analysis.jsonDocuments,
          directoryPaths,
          runtimePathKind: "node-entrypoint",
        })
      )
        resolvedUtilityEntrypoints += 1;
    }
    for (const finding of electron.native_addon_bindings) {
      if (!provenElectronFinding(finding)) continue;
      nativeAddonBindings += 1;
      if (
        resolvesToFile({
          file,
          specifier: finding.specifier,
          context: "module-specifier",
          files,
          jsonDocuments: analysis.jsonDocuments,
          directoryPaths,
          kind: "native-addon",
          moduleKind: finding.module_kind,
        })
      )
        resolvedNativeAddonBindings += 1;
    }
    for (const dynamic of electron.dynamic_code ?? []) {
      if (dynamic.cached_data_status === "declared")
        v8CachedDataCompilations += 1;
    }
  }

  let ipcOperations = 0;
  let dynamicChannelOperations = 0;
  let rendererTransmissions = 0;
  let rendererListeners = 0;
  let mainHandlers = 0;
  const literalChannels = new Set<string>();
  for (const record of ipcContext.records) {
    const { finding } = record;
    if (!provenElectronFinding(finding)) continue;
    ipcOperations += 1;
    if (finding.channel === null) dynamicChannelOperations += 1;
    else literalChannels.add(finding.channel);
    if (isRendererTransmission(record)) rendererTransmissions += 1;
    if (finding.side === "renderer" && finding.mode === "listen")
      rendererListeners += 1;
    if (isMainHandler(record)) mainHandlers += 1;
  }

  let pairedRendererTransmissions = 0;
  let ambiguousRendererTransmissions = 0;
  let unpairedLiteralRendererTransmissions = 0;
  for (const state of ipcContext.states) {
    if (!provenElectronFinding(state.transmission.finding)) continue;
    if (state.status === "paired") pairedRendererTransmissions += 1;
    else if (state.status === "ambiguous") ambiguousRendererTransmissions += 1;
    else if (
      state.status === "unpaired" &&
      state.transmission.finding.channel !== null
    )
      unpairedLiteralRendererTransmissions += 1;
  }

  // The coverage state is read from the retained analysis so that a rejected
  // projection cannot hide an Electron reference the graph still reports.
  const semantics = electronSemanticsState(coverageAnalysis);
  return {
    ...(semantics === undefined ? {} : { electron_semantics: semantics }),
    browser_windows: browserWindows,
    explicit_web_preferences: explicitWebPreferences,
    preload_entrypoints: preloadEntrypoints,
    context_bridge_apis: contextBridgeApis,
    exposed_api_members: exposedApiMembers,
    ipc: {
      operations: ipcOperations,
      literal_channels: literalChannels.size,
      dynamic_channel_operations: dynamicChannelOperations,
      renderer_transmissions: rendererTransmissions,
      renderer_listeners: rendererListeners,
      main_handlers: mainHandlers,
      paired_renderer_transmissions: pairedRendererTransmissions,
      ambiguous_renderer_transmissions: ambiguousRendererTransmissions,
      unpaired_literal_renderer_transmissions:
        unpairedLiteralRendererTransmissions,
    },
    sender_validation_observations: senderValidationObservations,
    utility_processes: utilityProcesses,
    resolved_utility_entrypoints: resolvedUtilityEntrypoints,
    native_addon_bindings: nativeAddonBindings,
    v8_cached_data_compilations: v8CachedDataCompilations,
    resolved_native_addon_bindings: resolvedNativeAddonBindings,
    protocol_registrations: protocolCount,
  };
};

const compatibleIpcModes = (
  transmission: ElectronIpcFinding,
  handler: ElectronIpcFinding,
): boolean =>
  transmission.mode === "invoke"
    ? handler.mode === "handle"
    : transmission.operation === "send-to-host"
      ? false
      : transmission.mode === "send" && handler.mode === "listen";

const isRendererTransmission = ({ finding }: ElectronIpcRecord): boolean =>
  finding.side === "renderer" &&
  (finding.mode === "send" || finding.mode === "invoke");

const isPairableRendererTransmission = (record: ElectronIpcRecord): boolean =>
  isRendererTransmission(record) && record.finding.operation !== "send-to-host";

/** Only an ipcMain registration on the same literal channel can be paired. */
const isExactIpcHandler = (handler: ElectronIpcRecord | undefined): boolean =>
  handler !== undefined &&
  handler.finding.receiver === undefined &&
  handler.finding.channel !== null;

const isMainHandler = ({ finding }: ElectronIpcRecord): boolean =>
  finding.side === "main" &&
  (finding.mode === "listen" || finding.mode === "handle");

interface ResolveToFileInput {
  readonly file: JavaScriptArtifactFile;
  readonly specifier: string;
  readonly context: "module-specifier" | "filesystem-expression";
  readonly files: ReadonlyMap<string, JavaScriptArtifactFile>;
  readonly jsonDocuments: JavaScriptJsonDocuments;
  readonly directoryPaths?: ReadonlySet<string> | undefined;
  readonly kind?: JavaScriptArtifactFile["kind"];
  readonly moduleKind?: "import" | "require";
  readonly runtimePathKind?: ResolveArtifactPathInput["runtimePathKind"];
}

const resolvesToFile = (input: ResolveToFileInput): boolean => {
  const resolved = resolveArtifactPathByContext({
    declaredPath: input.specifier,
    sourcePath: input.file.path,
    context: input.context,
    files: input.files,
    jsonDocuments: input.jsonDocuments,
    ...(input.directoryPaths === undefined
      ? {}
      : { directoryPaths: input.directoryPaths }),
    ...(input.runtimePathKind === undefined
      ? {}
      : { runtimePathKind: input.runtimePathKind }),
    ...(input.moduleKind === undefined ? {} : { moduleKind: input.moduleKind }),
  }).resolved_path;
  return (
    resolved !== null &&
    (input.kind === undefined || input.files.get(resolved)?.kind === input.kind)
  );
};

const ipcRecordKey = (path: string, finding: ElectronIpcFinding): string => {
  const identity = `${path}\0${String(finding.location.start.line)}:${String(finding.location.start.column)}\0${finding.side}\0${finding.operation}\0${finding.channel ?? finding.channel_expression}\0${JSON.stringify(finding.handler_location)}`;
  return finding.invocation_location === undefined
    ? identity
    : `${identity}\0${String(finding.invocation_location.start.line)}:${String(finding.invocation_location.start.column)}`;
};
