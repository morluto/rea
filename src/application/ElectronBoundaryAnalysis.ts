import type { ElectronIpcFinding } from "../domain/electronStaticAnalysisTypes.js";
import type { ElectronBoundarySummary } from "../domain/javascriptApplicationAnalysis.js";
import type { JavaScriptArtifactAnalysis } from "./JavaScriptArtifactAnalysisTypes.js";
import type { JavaScriptArtifactFile } from "./JavaScriptArtifactFiles.js";
import { resolveArtifactPath } from "./JavaScriptArtifactGraphContext.js";

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
    .sort((left, right) => compareCodePoints(left.key, right.key));

/** Match only exact literal channels and retain ambiguous matches separately. */
export const classifyElectronIpcPairings = (
  records: readonly ElectronIpcRecord[],
): readonly ElectronIpcPairingState[] => {
  const handlers = records.filter(isMainHandler);
  return records.filter(isPairableRendererTransmission).map((transmission) => {
    const candidates =
      transmission.finding.channel === null
        ? []
        : handlers.filter(
            (handler) =>
              handler.finding.channel === transmission.finding.channel &&
              compatibleIpcModes(transmission.finding, handler.finding),
          );
    return {
      transmission,
      candidates,
      status:
        candidates.length === 1
          ? "paired"
          : candidates.length > 1
            ? "ambiguous"
            : "unpaired",
    };
  });
};

/** Return only pairings supported by one unique literal main handler. */
export const unambiguousElectronIpcPairings = (
  records: readonly ElectronIpcRecord[],
): readonly ElectronIpcPairing[] =>
  classifyElectronIpcPairings(records).flatMap((state) => {
    const handler = state.candidates[0];
    return state.status === "paired" && handler !== undefined
      ? [{ transmission: state.transmission, handler }]
      : [];
  });

/** Summarize static Electron findings without treating gaps as absence. */
export const summarizeElectronBoundaries = (
  analysis: JavaScriptArtifactAnalysis,
): ElectronBoundarySummary => {
  const files = new Map(analysis.files.map(({ file }) => [file.path, file]));
  const javascript = analysis.files.flatMap(({ javascript: value }) =>
    value === null ? [] : [value],
  );
  const windows = javascript.flatMap(
    ({ electron }) => electron.browser_windows,
  );
  const bridges = javascript.flatMap(
    ({ electron }) => electron.context_bridge_apis,
  );
  const validations = javascript.flatMap(
    ({ electron }) => electron.sender_validations,
  );
  const utilities = analysis.files.flatMap(({ file, javascript: value }) =>
    (value?.electron.utility_processes ?? []).map((finding) => ({
      file,
      finding,
    })),
  );
  const nativeBindings = analysis.files.flatMap(({ file, javascript: value }) =>
    (value?.electron.native_addon_bindings ?? []).map((finding) => ({
      file,
      finding,
    })),
  );
  const ipc = collectElectronIpcRecords(analysis);
  const pairing = classifyElectronIpcPairings(ipc);
  const literalChannels = new Set(
    ipc.flatMap(({ finding }) =>
      finding.channel === null ? [] : [finding.channel],
    ),
  );
  return {
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
    resolved_utility_entrypoints: utilities.filter(({ file, finding }) =>
      resolvesToFile(file, finding.module_path, files),
    ).length,
    native_addon_bindings: nativeBindings.length,
    resolved_native_addon_bindings: nativeBindings.filter(({ file, finding }) =>
      resolvesToFile(file, finding.specifier, files, "native-addon"),
    ).length,
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

const isMainHandler = ({ finding }: ElectronIpcRecord): boolean =>
  finding.side === "main" &&
  (finding.mode === "listen" || finding.mode === "handle");

const resolvesToFile = (
  file: JavaScriptArtifactFile,
  specifier: string | null,
  files: ReadonlyMap<string, JavaScriptArtifactFile>,
  kind?: JavaScriptArtifactFile["kind"],
): boolean => {
  if (specifier === null) return false;
  const resolved = resolveArtifactPath(specifier, file.path, files);
  return (
    resolved !== null &&
    (kind === undefined || files.get(resolved)?.kind === kind)
  );
};

const ipcRecordKey = (path: string, finding: ElectronIpcFinding): string =>
  `${path}\0${String(finding.location.start.line)}:${String(finding.location.start.column)}\0${finding.side}\0${finding.operation}`;

const compareCodePoints = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;
