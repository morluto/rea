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
  detectStateFormat,
  keyfileView,
  plainRecord,
  SQLITE_SIDECARS,
  textualView,
} from "../../domain/desktop/stateFormats.js";
import {
  applicationNames,
  isApplicationDconfGroup,
  roleFacts,
  selectedHomePath,
  stateReasons,
  stateRole,
} from "../../domain/desktop/stateRoles.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { safeParseEvidence } from "../../domain/evidenceValidation.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { describeValidationFailure } from "../../domain/validationFailure.js";
import { PrivateRuntimeRoot } from "../../process/PrivateRuntimeRoot.js";
import { readJsonFile } from "../JsonFiles.js";
import { readZipView } from "./DesktopZipView.js";
import {
  withRetainedContent,
  type RetainedContent,
} from "./DesktopRetainedContent.js";
import {
  digestsAt,
  indexState,
  pathVersions,
  presenceAt,
  statePaths,
  type StateIndex,
} from "./DesktopStateVersions.js";
import {
  DESKTOP_OPERATION,
  DESKTOP_PROVIDER,
  desktopOperationFailure,
} from "./DesktopCaptureRefusals.js";

const OPERATION = "inspect_desktop_application_state";

/**
 * Readers for formats that need a tool or worker, supplied by composition. Each
 * database is staged with its retained log in a private directory the caller removes.
 */
export interface DesktopStateReaders {
  readonly sqlite: (
    database: string,
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
  readonly index: StateIndex;
}

const dconfGroups = (text: string, names: ReadonlySet<string>) => {
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

/** Whether a database's sidecar file existed at a version, and its retained digest. */
const sidecarAt = (path: string, version: Version, index: StateIndex) => ({
  present: presenceAt(path, index)[version.checkpoint_index] ?? null,
  sha256: digestsAt(path, index)[version.checkpoint_index] ?? null,
});

/**
 * A sidecar's verified bytes to stage beside the database, or why the
 * database cannot be read: reading it without a sidecar it had could hide or
 * misstate committed rows.
 */
const sidecarBytes = async (
  { path, version }: Pick<ReadInput, "path" | "version">,
  sidecar: (typeof SQLITE_SIDECARS)[number],
  context: ViewContext,
): Promise<Result<Buffer | undefined, string>> => {
  const { present, sha256 } = sidecarAt(
    `${path}${sidecar.suffix}`,
    version,
    context.index,
  );
  if (present === null)
    return err(
      `the capture did not record whether the database's ${sidecar.label} existed`,
    );
  if (present && sha256 === null)
    return err(`the database's ${sidecar.label} was not retained`);
  if (sha256 === null) return ok(undefined);
  const bytes = await context.content.read(sha256, context.signal);
  return bytes.ok
    ? ok(bytes.value)
    : err(`the database's ${sidecar.label} ${bytes.error}`);
};

const sqliteView = async (
  input: ReadInput,
  context: ViewContext,
): Promise<ViewOutcome> => {
  // The SQLite reader accepts an inactive rollback journal and refuses a hot one.
  const staged = [{ name: "state.db", bytes: input.bytes }];
  for (const sidecar of SQLITE_SIDECARS) {
    const bytes = await sidecarBytes(input, sidecar, context);
    if (!bytes.ok) return failed(bytes.error);
    if (bytes.value !== undefined)
      staged.push({ name: `state.db${sidecar.suffix}`, bytes: bytes.value });
  }
  return withStaged(staged, async ([database]) => {
    const read = await context.readers.sqlite(database ?? "", context.signal);
    return read.ok ? { view: read.view, error: null } : failed(read.error);
  });
};

const dconfView = async (
  { bytes }: ReadInput,
  context: ViewContext,
): Promise<ViewOutcome> =>
  withStaged([{ name: "user", bytes }], async ([database]) => {
    const dump = await context.readers.dconf(database ?? "", context.signal);
    return dump.ok
      ? { view: dconfGroups(dump.text, context.names), error: null }
      : failed(dump.error);
  });

/** A reader's result as a version's view or view_error. */
const outcomeOf = (read: Result<JsonValue, string>): ViewOutcome =>
  read.ok ? { view: read.value, error: null } : failed(read.error);

/** Read one retained version into JSON for its own format. */
const viewOf = async (
  input: ReadInput,
  context: ViewContext,
): Promise<ViewOutcome> => {
  const format = input.version.format ?? "binary";
  switch (format) {
    case "text":
    case "json":
    case "keyfile":
    case "xml":
      return outcomeOf(textualView(format, input.bytes));
    case "zip":
      return outcomeOf(await readZipView(input.bytes, context.signal));
    case "dconf":
      return dconfView(input, context);
    case "sqlite":
      return sqliteView(input, context);
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
  if (!bytes.ok) {
    version.view_error = `retained content ${bytes.error}`;
    return;
  }
  version.format = detectStateFormat(path, bytes.value);
  const outcome = await viewOf({ path, bytes: bytes.value, version }, context);
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
  const versions = pathVersions(capture, path, context.index);
  for (const version of versions) await readVersion(version, path, context);
  const reasons = [
    ...stateReasons(
      facts,
      path,
      (context.index.changes.get(path) ?? []).map((entry) => entry.change),
      versions.some(hasDconfGroups),
    ),
  ];
  const home = capture.host.home;
  return {
    path,
    home_path: path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null,
    role: stateRole(reasons, selectedHomePath(facts, path)),
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
  "SQLite views list at most 500 rows of at most 64 ordinary tables, text views at most 5,000 lines and XML views at most 5,000 nodes; changes between truncated views, or views with an unread table, are marked incomplete.",
  "JSON and key file views read files of at most 4 MiB, JSON nested at most 500 levels and only numbers JavaScript holds exactly; other files of those formats have a view_error.",
  "dconf views keep only groups whose path names the application.",
  "Zip views list at most 1,000 entries and read an entry only when it is unencrypted, stored or deflated, at most 16 MiB and at most 100 times its compressed size, up to 64 MiB per archive; databases and archives inside an archive are not read.",
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
  const index = indexState(capture);
  const paths = await withRetainedContent(folder, async (content) => {
    const context: ViewContext = { content, readers, names, signal, index };
    const described: DesktopStatePath[] = [];
    for (const path of statePaths(index))
      described.push(await describePath(capture, path, facts, context));
    return described;
  });
  const limitations = [
    ...STATE_LIMITATIONS,
    ...(capture.state.state_directories === undefined
      ? [
          "The capture does not record its state directories as walked, so files in a symlinked state directory may be classed as documents.",
        ]
      : []),
  ];
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
    limitations,
  };
  signal?.throwIfAborted();
  return createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-state",
    operation: OPERATION,
    parameters: { capture_evidence_id: evidence.evidence_id },
    result,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: [...limitations, ...capture.limitations],
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
