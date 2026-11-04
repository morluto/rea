import { createHash } from "node:crypto";
import { join } from "node:path";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import {
  desktopApplicationCaptureSchema,
  type DesktopApplicationCapture,
} from "../../domain/desktop/desktopCapture.js";
import type {
  DesktopApplicationState,
  DesktopStatePath,
} from "../../domain/desktop/desktopState.js";
import { diffStateViews } from "../../domain/desktop/stateChanges.js";
import {
  decodeStateText,
  detectStateFormat,
  keyfileView,
  textView,
  xmlView,
  type DesktopStateFormat,
} from "../../domain/desktop/stateFormats.js";
import {
  applicationNames,
  isApplicationDconfGroup,
  stateReasons,
  stateRole,
} from "../../domain/desktop/stateRoles.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { safeParseEvidence } from "../../domain/evidenceValidation.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { safeParseJson } from "../../domain/safeJson.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { withOwnedRegularFile } from "../../filesystem/OwnedRegularFile.js";
import { readStableFileBytes } from "../../filesystem/readStableFileBytes.js";
import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { readJsonFile } from "../JsonFiles.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
} from "./DesktopCaptureRefusals.js";

const OPERATION = "inspect_desktop_application_state";
const MAX_VIEW_BYTES = 64 * 1024 * 1024;

/** Readers for formats that need a tool or worker, supplied by composition. */
export interface DesktopStateReaders {
  readonly sqlite: (
    database: string,
    writeAheadLog: string | undefined,
    signal?: AbortSignal,
  ) => Promise<{ ok: true; view: JsonValue } | { ok: false; error: string }>;
  readonly dconf: (
    database: string,
    signal?: AbortSignal,
  ) => Promise<{ ok: true; text: string } | { ok: false; error: string }>;
}

type Version = DesktopStatePath["versions"][number];

const inputError = (userMessage: string, remediationAction: string) =>
  new AnalysisInputError(OPERATION, { userMessage, remediationAction }, [
    { path: ["capture"], reason: "invalid_value", message: userMessage },
  ]);

/** Admit `capture.json` only as complete desktop capture Evidence. */
const readCapture = async (
  folder: string,
  signal: AbortSignal | undefined,
): Promise<{ evidence: Evidence; capture: DesktopApplicationCapture }> => {
  const resources = new ArtifactResourceScope();
  try {
    const loaded = await readJsonFile(
      join(folder, "capture.json"),
      signal,
      resources,
      OPERATION,
    );
    if (!loaded.ok) {
      if (loaded.error instanceof AnalysisError) throw loaded.error;
      throw inputError(
        `${join(folder, "capture.json")} could not be read as JSON.`,
        "Pass a folder written by capture-desktop-application.",
      );
    }
    const evidence = safeParseEvidence(loaded.value);
    if (
      !evidence.ok ||
      evidence.value.operation !== DESKTOP_OPERATION ||
      evidence.value.predicate_type !== "rea.desktop-application-capture" ||
      evidence.value.provider.id !== DESKTOP_PROVIDER.id ||
      evidence.value.provider.version !== DESKTOP_PROVIDER.version
    )
      throw inputError(
        "capture.json is not desktop application capture Evidence.",
        "Pass a folder written by capture-desktop-application.",
      );
    const capture = desktopApplicationCaptureSchema.safeParse(
      evidence.value.normalized_result,
    );
    if (!capture.success)
      throw inputError(
        `The capture result is malformed (${describeValidationFailure(capture.error)}).`,
        "Capture the application again.",
      );
    return { evidence: evidence.value, capture: capture.data };
  } finally {
    await resources.close();
  }
};

/** Retained bytes, checked against the digest that names them. */
const readContent = async (
  folder: string,
  sha256: string,
  signal: AbortSignal | undefined,
): Promise<Buffer | undefined> => {
  const path = join(folder, "content", sha256);
  const options = {
    symlinks: "reject" as const,
    ...(signal === undefined ? {} : { signal }),
  };
  const bytes = await withOwnedRegularFile(path, options, ({ handle }) =>
    readStableFileBytes(handle, path, MAX_VIEW_BYTES, options),
  ).catch(() => undefined);
  if (bytes === undefined) return undefined;
  return createHash("sha256").update(bytes).digest("hex") === sha256
    ? bytes
    : undefined;
};

/** Versions of one path: its baseline, then its state after each change. */
const pathVersions = (
  capture: DesktopApplicationCapture,
  path: string,
): Version[] => {
  const [baseline, ...later] = capture.state.checkpoints;
  const retained = baseline?.retained.find((file) => file.path === path);
  const firstChange = later
    .flatMap((checkpoint) => checkpoint.changes)
    .find((change) => change.path === path);
  const versions: Version[] = [
    {
      checkpoint: baseline?.name ?? "baseline",
      present: retained !== undefined || firstChange?.kind !== "created",
      sha256: retained?.sha256 ?? null,
      view: null,
      view_error: null,
    },
  ];
  for (const checkpoint of later)
    for (const change of checkpoint.changes)
      if (change.path === path)
        versions.push({
          checkpoint: checkpoint.name,
          present: change.after?.type === "file",
          sha256: change.after?.sha256 ?? null,
          view: null,
          view_error: null,
        });
  return versions;
};

/** Files the state view covers: retained at baseline or changed later. */
const statePaths = (capture: DesktopApplicationCapture): readonly string[] => {
  const paths = new Set<string>();
  for (const checkpoint of capture.state.checkpoints) {
    for (const file of checkpoint.retained) paths.add(file.path);
    for (const change of checkpoint.changes)
      if (change.before?.type === "file" || change.after?.type === "file")
        paths.add(change.path);
  }
  return [...paths].sort();
};

interface ViewContext {
  readonly folder: string;
  readonly readers: DesktopStateReaders;
  readonly names: ReadonlySet<string>;
  readonly signal: AbortSignal | undefined;
  /** Retained write-ahead logs by database path, latest version first. */
  readonly writeAheadLogs: ReadonlyMap<string, string>;
}

const dconfView = (text: string, names: ReadonlySet<string>) => {
  const groups = keyfileView(text);
  const application: Record<string, JsonValue> = {};
  const others: string[] = [];
  for (const [group, keys] of Object.entries(groups))
    if (isApplicationDconfGroup(group, names)) application[group] = keys;
    else others.push(group);
  return { groups: application, other_groups: others };
};

/** Read one retained version into JSON for its format. */
const viewOf = async (
  format: DesktopStateFormat,
  path: string,
  bytes: Buffer,
  context: ViewContext,
): Promise<{ view: JsonValue | null; error: string | null }> => {
  const text = decodeStateText(bytes) ?? "";
  const content = (sha: string) => join(context.folder, "content", sha);
  switch (format) {
    case "text":
      return { view: textView(text), error: null };
    case "json": {
      const parsed = safeParseJson(text);
      return parsed.ok
        ? { view: parsed.value as JsonValue, error: null }
        : { view: null, error: parsed.error };
    }
    case "keyfile":
      return { view: { groups: keyfileView(text) }, error: null };
    case "xml": {
      const tree = xmlView(text);
      return tree === undefined
        ? { view: null, error: "not well-formed XML, or it declares a DOCTYPE" }
        : { view: tree, error: null };
    }
    case "dconf": {
      const sha = createHash("sha256").update(bytes).digest("hex");
      const dump = await context.readers.dconf(content(sha), context.signal);
      return dump.ok
        ? { view: dconfView(dump.text, context.names), error: null }
        : { view: null, error: dump.error };
    }
    case "sqlite": {
      const sha = createHash("sha256").update(bytes).digest("hex");
      const wal = context.writeAheadLogs.get(path);
      const read = await context.readers.sqlite(
        content(sha),
        wal === undefined ? undefined : content(wal),
        context.signal,
      );
      return read.ok
        ? { view: read.view, error: null }
        : { view: null, error: read.error };
    }
    case "binary":
      return { view: null, error: null };
  }
};

const changeBetween = (
  format: DesktopStateFormat | null,
  before: Version,
  after: Version,
): DesktopStatePath["changes"][number] => {
  const empty = {
    added: [],
    removed: [],
    changed: [],
    added_count: 0,
    removed_count: 0,
    changed_count: 0,
  };
  const ends = { from: before.checkpoint, to: after.checkpoint };
  if (!before.present) return { ...ends, kind: "created", ...empty };
  if (!after.present) return { ...ends, kind: "deleted", ...empty };
  if (format === null || before.view === null || after.view === null)
    return {
      ...ends,
      kind: format === "binary" ? "content" : "unreadable",
      ...empty,
    };
  const difference = diffStateViews(format, before.view, after.view);
  return {
    ...ends,
    ...difference,
    added: [...difference.added],
    removed: [...difference.removed],
    changed: [...difference.changed],
  };
};

/** The latest retained write-ahead log of each database path. */
const writeAheadLogs = (
  capture: DesktopApplicationCapture,
): ReadonlyMap<string, string> => {
  const logs = new Map<string, string>();
  for (const checkpoint of capture.state.checkpoints)
    for (const file of checkpoint.retained)
      if (file.path.endsWith("-wal"))
        logs.set(file.path.slice(0, -"-wal".length), file.sha256);
  return logs;
};

const describePath = async (
  capture: DesktopApplicationCapture,
  path: string,
  context: ViewContext,
): Promise<DesktopStatePath> => {
  const versions = pathVersions(capture, path);
  let format: DesktopStateFormat | null = null;
  for (const version of versions) {
    context.signal?.throwIfAborted();
    if (!version.present || version.sha256 === null) {
      if (version.present) version.view_error = "content not retained";
      continue;
    }
    const bytes = await readContent(
      context.folder,
      version.sha256,
      context.signal,
    );
    if (bytes === undefined) {
      version.view_error =
        "retained content is missing or does not match its digest";
      continue;
    }
    format ??= detectStateFormat(path, bytes);
    const { view, error } = await viewOf(format, path, bytes, context);
    version.view = view;
    version.view_error = error;
  }
  const dconfKeys =
    format === "dconf" &&
    versions.some((version) => {
      const view = version.view;
      return (
        typeof view === "object" &&
        view !== null &&
        !Array.isArray(view) &&
        typeof view.groups === "object" &&
        view.groups !== null &&
        Object.keys(view.groups).length > 0
      );
    });
  const reasons = [...stateReasons(capture, path, dconfKeys)];
  const home = capture.host.home;
  return {
    path,
    home_path: path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null,
    role: stateRole(reasons),
    reasons,
    format,
    versions,
    changes: versions
      .slice(1)
      .map((version, index) =>
        changeBetween(format, versions[index] ?? version, version),
      ),
  };
};

const STATE_LIMITATIONS = [
  "Roles are inferred from state directories, open files, window titles, selected paths and dconf key names; a path can be misattributed.",
  "Views cover retained content only; a file that existed before the capture but outside the content roots has no starting view.",
  "SQLite views list at most 500 rows of at most 64 ordinary tables; dconf views keep only groups whose path names the application.",
];

/** Read a capture folder into the application's state view. */
const inspectState = async (
  folder: string,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const { evidence, capture } = await readCapture(folder, signal);
  const names = applicationNames(capture);
  const context: ViewContext = {
    folder,
    readers,
    names,
    signal,
    writeAheadLogs: writeAheadLogs(capture),
  };
  const paths: DesktopStatePath[] = [];
  for (const path of statePaths(capture))
    paths.push(await describePath(capture, path, context));
  const result: DesktopApplicationState = {
    capture: {
      evidence_id: evidence.evidence_id,
      home: capture.host.home,
      checkpoints: capture.state.checkpoints.map(
        (checkpoint) => checkpoint.name,
      ),
    },
    application_names: [...names],
    paths,
    limitations: STATE_LIMITATIONS,
  };
  return createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-state",
    operation: OPERATION,
    parameters: { capture_evidence_id: evidence.evidence_id },
    result,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: STATE_LIMITATIONS,
  });
};

/** Inspect one capture folder, returning its state view Evidence or a failure. */
export const inspectDesktopApplicationState = async (
  folder: string,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
): Promise<Evidence | AnalysisError> => {
  try {
    return await inspectState(folder, readers, signal);
  } catch (cause: unknown) {
    if (cause instanceof AnalysisError) return cause;
    if (signal?.aborted === true)
      return new AnalysisCancelledError(OPERATION, { cause: signal.reason });
    return new ProviderAdapterError(DESKTOP_PROVIDER.id, OPERATION, {
      cause,
      diagnostics: { phase: "desktop_state" },
      userMessage: `Desktop state view could not complete: ${describeValidationFailure(cause)}`,
    });
  }
};
