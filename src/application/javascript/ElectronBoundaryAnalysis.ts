import { isPossibleCachedDataCompilation } from "../../domain/javascript/electronDynamicCodeFacts.js";
import type { JavaScriptJsonDocuments } from "./JavaScriptJsonDocuments.js";
import { compareUnicodeCodePoints } from "../../domain/unicodeCodePointOrder.js";
import type { ElectronIpcFinding } from "../../domain/javascript/electronStaticAnalysisTypes.js";
import {
  ELECTRON_MODULE,
  ELECTRON_REFERENCE_KINDS,
} from "../../domain/javascript/javascriptElectronMemberWrites.js";
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
  coverageComplete = true,
): ElectronIpcContext => {
  const records = collectElectronIpcRecords(analysis);
  const owners = new Map(
    records.map((record) => [record.key, applicationOwner(record.file)]),
  );
  const handlers = records.filter(isMainHandler);
  const states: ElectronIpcPairingState[] = records
    .filter(isPairableRendererTransmission)
    .map((transmission) => {
      const owner = owners.get(transmission.key);
      const channel = transmission.finding.channel;
      const matching =
        channel === null
          ? []
          : handlers.filter(
              (handler) =>
                (handler.finding.channel === channel ||
                  mayReceiveChannel(handler, channel)) &&
                compatibleIpcModes(transmission.finding, handler.finding),
            );
      const candidates = matching.filter(
        (handler) => owners.get(handler.key) === owner,
      );
      // Unknown ownership can conceal competing dispatch contexts. Different owners
      // do not prove runtime isolation, so retain ambiguity rather than absence.
      const uncertain =
        !coverageComplete ||
        owner == null ||
        transmission.finding.loader_authority === "candidate" ||
        matching.some(
          ({ finding }) => finding.loader_authority === "candidate",
        ) ||
        matching.some((handler) => owners.get(handler.key) == null);
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
          !matching.some((handler) => owners.get(handler.key) == null)
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

/**
 * Whether one analyzed source loads an Electron module.
 *
 * `analysis_coverage.applicability.electron` is the domain owner of this
 * question: it already excludes a `type-import`, a `require.resolve` that only
 * locates the module, a `worker` URL path, and a specifier that is a recovered
 * bundle module key. Reading the owned fact here keeps the boundary summary and
 * the published coverage view from disagreeing.
 *
 * Historical evidence may predate that field, so the retained references answer
 * the same question for those files.
 */
const electronModuleReferencedBy = ({
  javascript,
  semantic,
}: AnalyzedJavaScriptArtifactFile): boolean => {
  const applicability = javascript?.analysis_coverage?.applicability.electron;
  if (applicability !== undefined) return applicability === "observed";
  const links = semantic?.ir.moduleLinks;
  if (
    links !== undefined &&
    links.some(
      ({ specifier, kind, loaderAuthority }) =>
        kind !== "type-import" &&
        loaderAuthority !== "candidate" &&
        specifier !== null &&
        ELECTRON_MODULE.test(specifier),
    )
  )
    return true;
  return (javascript?.references ?? []).some(
    ({ specifier, kind, operation, loader_authority }) =>
      operation === "load" &&
      loader_authority !== "candidate" &&
      ELECTRON_REFERENCE_KINDS.has(kind) &&
      specifier !== null &&
      ELECTRON_MODULE.test(specifier),
  );
};

/** Whether any analyzed source loads an Electron module. */
const electronModuleReferenced = (
  analysis: JavaScriptArtifactAnalysis,
): boolean => analysis.files.some(electronModuleReferencedBy);

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
        : javascript.electron.browser_windows.filter(provenElectronFinding)
            .length +
          javascript.electron.context_bridge_apis.filter(provenElectronFinding)
            .length +
          javascript.electron.ipc.filter(provenElectronFinding).length +
          javascript.electron.sender_validations.filter(provenElectronFinding)
            .length +
          javascript.electron.utility_processes.filter(provenElectronFinding)
            .length +
          javascript.electron.native_addon_bindings.filter(
            provenElectronFinding,
          ).length +
          javascript.electron.protocols.filter(provenElectronFinding).length +
          (javascript.electron.dynamic_code ?? []).filter(
            isPossibleCachedDataCompilation,
          ).length),
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
  const status = javascript.analysis_coverage?.examination.status;
  const syntax = javascript.analysis_coverage?.syntax.status;
  return (
    javascript.parse_status !== "complete" ||
    (syntax !== undefined && syntax !== "complete") ||
    (status !== undefined && status !== "complete")
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
  const files = new Map(analysis.files.map(({ file }) => [file.path, file]));
  const javascript = analysis.files.flatMap(({ javascript: value }) =>
    value === null ? [] : [value],
  );
  const windows = javascript.flatMap(({ electron }) =>
    electron.browser_windows.filter(provenElectronFinding),
  );
  const bridges = javascript.flatMap(({ electron }) =>
    electron.context_bridge_apis.filter(provenElectronFinding),
  );
  const validations = javascript.flatMap(({ electron }) =>
    electron.sender_validations.filter(provenElectronFinding),
  );
  const utilities = analysis.files.flatMap(({ file, javascript: value }) =>
    (value?.electron.utility_processes ?? [])
      .filter(provenElectronFinding)
      .map((finding) => ({
        file,
        finding,
      })),
  );
  const nativeBindings = analysis.files.flatMap(({ file, javascript: value }) =>
    (value?.electron.native_addon_bindings ?? [])
      .filter(provenElectronFinding)
      .map((finding) => ({
        file,
        finding,
      })),
  );
  const ipc = ipcContext.records.filter(({ finding }) =>
    provenElectronFinding(finding),
  );
  const pairing = ipcContext.states.filter(({ transmission }) =>
    provenElectronFinding(transmission.finding),
  );
  const literalChannels = new Set(
    ipc.flatMap(({ finding }) =>
      finding.channel === null ? [] : [finding.channel],
    ),
  );
  const protocolCount = javascript.reduce(
    (count, { electron }) =>
      count + electron.protocols.filter(provenElectronFinding).length,
    0,
  );
  // The coverage state is read from the retained analysis so that a rejected
  // projection cannot hide an Electron reference the graph still reports.
  const semantics = electronSemanticsState(coverageAnalysis);
  return {
    ...(semantics === undefined ? {} : { electron_semantics: semantics }),
    browser_windows: windows.length,
    explicit_web_preferences: windows.reduce(
      (count, window) => count + window.web_preferences.length,
      0,
    ),
    preload_entrypoints: windows.filter(
      ({ preload_path: path }) => path !== null,
    ).length,
    context_bridge_apis: bridges.length,
    exposed_api_members: bridges.reduce(
      (count, bridge) => count + bridge.members.length,
      0,
    ),
    ipc: {
      operations: ipc.length,
      literal_channels: literalChannels.size,
      dynamic_channel_operations: ipc.filter(
        ({ finding }) => finding.channel === null,
      ).length,
      renderer_transmissions: ipc.filter(isRendererTransmission).length,
      renderer_listeners: ipc.filter(
        ({ finding }) =>
          finding.side === "renderer" && finding.mode === "listen",
      ).length,
      main_handlers: ipc.filter(isMainHandler).length,
      paired_renderer_transmissions: pairing.filter(
        ({ status }) => status === "paired",
      ).length,
      ambiguous_renderer_transmissions: pairing.filter(
        ({ status }) => status === "ambiguous",
      ).length,
      unpaired_literal_renderer_transmissions: pairing.filter(
        ({ status, transmission }) =>
          status === "unpaired" && transmission.finding.channel !== null,
      ).length,
    },
    sender_validation_observations: validations.length,
    utility_processes: utilities.length,
    resolved_utility_entrypoints: utilities.filter(
      ({ file, finding }) =>
        finding.module_path !== null &&
        resolvesToFile({
          file,
          specifier: finding.module_path,
          context: finding.module_resolution_context,
          files,
          jsonDocuments: analysis.jsonDocuments,
          directoryPaths,
          runtimePathKind: "node-entrypoint",
        }),
    ).length,
    native_addon_bindings: nativeBindings.length,
    v8_cached_data_compilations: javascript.reduce(
      (count, { electron }) =>
        count +
        (electron.dynamic_code ?? []).filter(
          ({ cached_data_status }) => cached_data_status === "declared",
        ).length,
      0,
    ),
    resolved_native_addon_bindings: nativeBindings.filter(({ file, finding }) =>
      resolvesToFile({
        file,
        specifier: finding.specifier,
        context: "module-specifier",
        files,
        jsonDocuments: analysis.jsonDocuments,
        directoryPaths,
        kind: "native-addon",
        moduleKind: finding.module_kind,
      }),
    ).length,
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

/**
 * An unresolved channel may receive any literal channel, so it competes without
 * ever pairing. A wrapper site whose invocations all supplied literal channels
 * is represented by their findings, except guarded invocations, which have none
 * and still compete for their own channels.
 */
const mayReceiveChannel = (
  { finding }: ElectronIpcRecord,
  channel: string,
): boolean =>
  finding.channel === null &&
  (finding.receiver !== undefined ||
    finding.invocation_channels !== "literal" ||
    finding.guarded_invocation_channels?.includes(channel) === true);

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
