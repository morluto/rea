import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
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
  plainRecord,
  textView,
  xmlView,
} from "../../domain/desktop/stateFormats.js";
import {
  applicationNames,
  isApplicationDconfGroup,
  roleFacts,
  stateReasons,
  stateRole,
} from "../../domain/desktop/stateRoles.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { safeParseEvidence } from "../../domain/evidenceValidation.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { safeParseJson } from "../../domain/safeJson.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { readJsonFile } from "../JsonFiles.js";
import {
  withRetainedContent,
  type RetainedContent,
} from "./DesktopRetainedContent.js";
import {
  baselineDigests,
  digestsAt,
  indexChanges,
  pathVersions,
  presenceAt,
  statePaths,
  type ChangeIndex,
} from "./DesktopStateVersions.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
  desktopOperationFailure,
} from "./DesktopCaptureRefusals.js";

const OPERATION = "inspect_desktop_application_state";

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
type Change = DesktopStatePath["changes"][number];

const inputError = (userMessage: string, remediationAction: string) =>
  new AnalysisInputError(OPERATION, { userMessage, remediationAction }, [
    { path: ["capture"], reason: "invalid_value", message: userMessage },
  ]);

/** Admit `capture.json` only as complete desktop capture Evidence. */
export const readDesktopCapture = async (
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

interface ViewContext {
  readonly content: RetainedContent;
  readonly readers: DesktopStateReaders;
  readonly names: ReadonlySet<string>;
  readonly signal: AbortSignal | undefined;
  readonly changes: ChangeIndex;
  readonly baseline: ReadonlyMap<string, string>;
  readonly checkpoints: number;
}

const dconfView = (text: string, names: ReadonlySet<string>) => {
  const groups = keyfileView(text);
  const application = plainRecord<JsonValue>();
  const others: string[] = [];
  for (const [group, keys] of Object.entries(groups))
    if (isApplicationDconfGroup(group, names)) application[group] = keys;
    else others.push(group);
  return { groups: application, other_groups: others };
};

/**
 * Run a reader on verified bytes written to a private directory. A failed
 * removal keeps the directory's owner and is reported with the read's outcome.
 */
const withStaged = async <Value>(
  files: readonly { readonly name: string; readonly bytes: Buffer }[],
  read: (paths: readonly string[]) => Promise<Value>,
): Promise<Value> => {
  const root = await PrivateRuntimeRoot.create({
    prefix: "rea-desktop-state-",
  });
  let outcome:
    | { readonly kind: "completed"; readonly value: Value }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    const paths: string[] = [];
    for (const file of files) {
      const path = join(root.path, file.name);
      await writeFile(path, file.bytes, { mode: 0o600, flag: "wx" });
      paths.push(path);
    }
    outcome = { kind: "completed", value: await read(paths) };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  const resources = new ArtifactResourceScope();
  const removed = await resources.release({
    kind: "private-runtime-root",
    resource: root.path,
    root,
  });
  if (removed.kind === "failed")
    throw resources.cleanupFailure(outcome, [removed]);
  if (outcome.kind === "failed") throw outcome.cause;
  return outcome.value;
};

type ViewOutcome =
  | { readonly view: JsonValue; readonly error: null }
  | { readonly view: null; readonly error: string };

const failed = (error: string): ViewOutcome => ({ view: null, error });

/** One retained version's verified bytes, with its format already detected. */
interface ReadInput {
  readonly path: string;
  readonly bytes: Buffer;
  readonly version: Version;
}

const toolView = async (
  { path, bytes, version }: ReadInput,
  context: ViewContext,
): Promise<ViewOutcome> => {
  if (version.format === "dconf")
    return withStaged([{ name: "user", bytes }], async ([database]) => {
      const dump = await context.readers.dconf(database ?? "", context.signal);
      return dump.ok
        ? { view: dconfView(dump.text, context.names), error: null }
        : failed(dump.error);
    });
  const logPath = `${path}-wal`;
  const at = (values: readonly (string | boolean | null)[]) =>
    values[version.checkpoint_index];
  const logPresent =
    at(
      presenceAt(
        logPath,
        context.changes,
        context.baseline,
        context.checkpoints,
      ),
    ) === true;
  const logDigest = at(
    digestsAt(logPath, context.changes, context.baseline, context.checkpoints),
  );
  // Reading the database without a log it had would hide committed rows.
  if (logPresent && typeof logDigest !== "string")
    return failed("the database's write-ahead log was not retained");
  const log =
    typeof logDigest === "string"
      ? await context.content.read(logDigest, context.signal)
      : undefined;
  if (typeof logDigest === "string" && log === undefined)
    return failed(
      "the database's write-ahead log is missing or does not match its digest",
    );
  const staged = [
    { name: "state.db", bytes },
    ...(log === undefined ? [] : [{ name: "state.db-wal", bytes: log }]),
  ];
  return withStaged(staged, async ([database, wal]) => {
    const read = await context.readers.sqlite(
      database ?? "",
      wal,
      context.signal,
    );
    return read.ok ? { view: read.view, error: null } : failed(read.error);
  });
};

/** Read one retained version into JSON for its own format. */
const viewOf = async (
  input: ReadInput,
  context: ViewContext,
): Promise<ViewOutcome> => {
  const text = decodeStateText(input.bytes) ?? "";
  switch (input.version.format ?? "binary") {
    case "text":
      return { view: textView(text), error: null };
    case "json": {
      const parsed = safeParseJson(text);
      return parsed.ok
        ? { view: parsed.value as JsonValue, error: null }
        : failed(parsed.error);
    }
    case "keyfile":
      return { view: { groups: keyfileView(text) }, error: null };
    case "xml": {
      const tree = xmlView(text);
      return tree === undefined
        ? failed("not well-formed XML, or it declares a DOCTYPE")
        : { view: tree, error: null };
    }
    case "dconf":
    case "sqlite":
      return toolView(input, context);
    case "binary":
      return { view: null, error: null };
  }
};

const EMPTY_CHANGE = {
  added: [],
  removed: [],
  changed: [],
  added_count: 0,
  removed_count: 0,
  changed_count: 0,
  complete: true,
};

const changeBetween = (before: Version, after: Version): Change => {
  const ends = {
    from_index: before.checkpoint_index,
    to_index: after.checkpoint_index,
    from: before.checkpoint,
    to: after.checkpoint,
  };
  if (!before.present) return { ...ends, kind: "created", ...EMPTY_CHANGE };
  if (!after.present) return { ...ends, kind: "deleted", ...EMPTY_CHANGE };
  if (
    before.view_error !== null ||
    after.view_error !== null ||
    before.format === null ||
    after.format === null
  )
    return { ...ends, kind: "unreadable", ...EMPTY_CHANGE };
  if (before.format !== after.format)
    return { ...ends, kind: "format", ...EMPTY_CHANGE };
  if (before.format === "binary")
    return { ...ends, kind: "content", ...EMPTY_CHANGE };
  const difference = diffStateViews(before.format, before.view, after.view);
  return {
    ...ends,
    ...difference,
    added: [...difference.added],
    removed: [...difference.removed],
    changed: [...difference.changed],
  };
};

const readVersion = async (
  version: Version,
  path: string,
  context: ViewContext,
): Promise<void> => {
  context.signal?.throwIfAborted();
  if (!version.present) return;
  if (version.sha256 === null) {
    version.view_error = "content not retained";
    return;
  }
  const bytes = await context.content.read(version.sha256, context.signal);
  if (bytes === undefined) {
    version.view_error =
      "retained content is missing or does not match its digest";
    return;
  }
  version.format = detectStateFormat(path, bytes);
  const outcome = await viewOf({ path, bytes, version }, context);
  version.view = outcome.view;
  version.view_error = outcome.error;
};

const hasDconfGroups = (version: Version): boolean => {
  const view = version.view;
  return (
    version.format === "dconf" &&
    typeof view === "object" &&
    view !== null &&
    !Array.isArray(view) &&
    typeof view.groups === "object" &&
    view.groups !== null &&
    Object.keys(view.groups).length > 0
  );
};

/** Read every version of one path and derive its role and changes. */
const describePath = async (
  capture: DesktopApplicationCapture,
  path: string,
  facts: ReturnType<typeof roleFacts>,
  context: ViewContext,
): Promise<DesktopStatePath> => {
  const versions = pathVersions(
    capture,
    path,
    context.changes,
    context.baseline,
  );
  for (const version of versions) await readVersion(version, path, context);
  const reasons = [
    ...stateReasons(
      facts,
      path,
      (context.changes.get(path) ?? []).map((entry) => entry.change),
      versions.some(hasDconfGroups),
    ),
  ];
  const home = capture.host.home;
  return {
    path,
    home_path: path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null,
    role: stateRole(reasons),
    reasons,
    format:
      versions.findLast((version) => version.format !== null)?.format ?? null,
    versions,
    changes: versions
      .slice(1)
      .map((version, index) =>
        changeBetween(versions[index] ?? version, version),
      ),
  };
};

const STATE_LIMITATIONS = [
  "Roles are inferred from state directories, open files, window titles, selected paths and dconf key names; a path can be misattributed.",
  "Views cover retained content only; a file that existed before the capture but outside the content roots has no starting view.",
  "SQLite views list at most 500 rows of at most 64 ordinary tables, text views at most 5,000 lines and XML views at most 5,000 nodes; changes between truncated views are marked incomplete.",
  "dconf views keep only groups whose path names the application.",
];

/** Read a capture folder into the application's state view. */
const inspectState = async (
  folder: string,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
): Promise<Evidence> => {
  const { evidence, capture } = await readDesktopCapture(folder, signal);
  const names = applicationNames(capture);
  const facts = roleFacts(capture);
  const changes = indexChanges(capture);
  const paths = await withRetainedContent(folder, async (content) => {
    const context: ViewContext = {
      content,
      readers,
      names,
      signal,
      changes,
      baseline: baselineDigests(capture),
      checkpoints: capture.state.checkpoints.length,
    };
    const described: DesktopStatePath[] = [];
    for (const path of statePaths(capture, changes))
      described.push(await describePath(capture, path, facts, context));
    return described;
  });
  const result: DesktopApplicationState = {
    capture: {
      evidence_id: evidence.evidence_id,
      home: capture.host.home,
      checkpoints: capture.state.checkpoints.map(
        (checkpoint) => checkpoint.name,
      ),
      limitations: capture.limitations,
      omitted_content: capture.state.omitted_content,
    },
    application_names: [...names],
    paths,
    limitations: [
      ...STATE_LIMITATIONS,
      ...(capture.state.state_directories === undefined
        ? [
            "The capture does not record its state directories as walked, so files in a symlinked state directory may be classed as documents.",
          ]
        : []),
    ],
  };
  return createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-state",
    operation: OPERATION,
    parameters: { capture_evidence_id: evidence.evidence_id },
    result,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: [...STATE_LIMITATIONS, ...capture.limitations],
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
    return desktopOperationFailure(
      cause,
      signal,
      OPERATION,
      "Desktop state view",
    );
  }
};
