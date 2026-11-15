import {
  desktopViewPolicy,
  desktopViewPolicyInputSchema,
  type DesktopViewPolicy,
  type DesktopViewPolicyInput,
} from "../../domain/desktop/desktopViewPolicy.js";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ArtifactResourceScope } from "../../artifacts/ArtifactResourceScope.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  AnalysisCancelledError,
  AnalysisInputError,
} from "../../domain/analysisErrorCore.js";
import { analysisErrorWithCancellation } from "../../domain/analysisErrorCancellation.js";
import { analysisErrorWithCleanupFailure } from "../../domain/analysisErrorCleanup.js";
import { analysisInputErrorFromIssues } from "../../domain/inputIssueProjection.js";
import {
  desktopApplicationCaptureSchema,
  type DesktopApplicationCapture,
} from "../../domain/desktop/desktopCapture.js";
import type {
  DesktopApplicationState,
  DesktopStatePath,
} from "../../domain/desktop/desktopState.js";
import { openStateDocument } from "../../domain/desktop/gzipDocument.js";
import { diffStateViews } from "../../domain/desktop/stateChanges.js";
import {
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
  indexState,
  observedFileAt,
  pathVersions,
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
 * Expected format/read failures return an error result. Cancellation throws a typed
 * AnalysisCancelledError or ArtifactReaderFailure; cleanup failures retain their owner.
 */
export interface DesktopStateReaders {
  readonly sqlite: (
    database: string,
    signal?: AbortSignal,
    policy?: DesktopViewPolicy,
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
  const outcome = await resources
    .run(async () => {
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
    })
    .then(ok, (cause: unknown) => err(cause));
  try {
    await resources.close();
  } catch (cause: unknown) {
    const cleanup = desktopOperationFailure(
      cause,
      signal,
      OPERATION,
      "Desktop capture input",
    );
    if (outcome.ok && !signal?.aborted)
      throw cleanup.retainPartialObservation(outcome.value.evidence);
    const primary = outcome.ok
      ? new AnalysisCancelledError(OPERATION, {
          cause: signal?.reason,
        }).retainPartialObservation(outcome.value.evidence)
      : desktopOperationFailure(
          outcome.error,
          undefined,
          OPERATION,
          "Desktop capture input",
        );
    if (!outcome.ok && signal?.aborted)
      analysisErrorWithCancellation(
        primary,
        new AnalysisCancelledError(OPERATION, { cause: signal.reason }),
      );
    throw analysisErrorWithCleanupFailure(
      primary,
      cleanup,
      OPERATION,
    ).bindCleanupDependencies([primary, cleanup]);
  }
  if (!outcome.ok) {
    if (!signal?.aborted) throw outcome.error;
    throw analysisErrorWithCancellation(
      desktopOperationFailure(
        outcome.error,
        undefined,
        OPERATION,
        "Desktop capture input",
      ),
      new AnalysisCancelledError(OPERATION, { cause: signal.reason }),
    );
  }
  if (signal?.aborted)
    throw new AnalysisCancelledError(OPERATION, {
      cause: signal.reason,
    }).retainPartialObservation(outcome.value.evidence);
  return outcome.value;
};

interface ViewContext {
  readonly content: RetainedContent;
  readonly readers: DesktopStateReaders;
  readonly names: ReadonlySet<string>;
  readonly signal: AbortSignal | undefined;
  readonly index: StateIndex;
  readonly policy: DesktopViewPolicy;
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
  files: readonly { readonly name: string; readonly bytes: Uint8Array }[],
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

/** One retained version's verified document, a gzip file's decompressed, with its format already detected. */
interface ReadInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly version: Version;
}

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
  const { present, sha256 } = observedFileAt(
    `${path}${sidecar.suffix}`,
    version.checkpoint_index,
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
  const database = observedFileAt(
    input.path,
    input.version.checkpoint_index,
    context.index,
  );
  if (database.present !== true || database.sha256 !== input.version.sha256)
    return failed(
      "the capture did not confirm the database's retained version at this checkpoint",
    );
  // The SQLite reader accepts an inactive rollback journal and refuses a hot one.
  const staged = [{ name: "state.db", bytes: input.bytes }];
  for (const sidecar of SQLITE_SIDECARS) {
    const bytes = await sidecarBytes(input, sidecar, context);
    if (!bytes.ok) return failed(bytes.error);
    if (bytes.value !== undefined)
      staged.push({ name: `state.db${sidecar.suffix}`, bytes: bytes.value });
  }
  return withStaged(staged, async ([database]) => {
    const read = await context.readers.sqlite(
      database ?? "",
      context.signal,
      context.policy,
    );
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
      return outcomeOf(textualView(format, input.bytes, context.policy));
    case "zip":
      return outcomeOf(
        await readZipView(input.bytes, context.signal, context.policy),
      );
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
  if (context.signal?.aborted === true)
    throw new AnalysisCancelledError(OPERATION, {
      cause: context.signal.reason,
    });
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
  const document = openStateDocument(path, bytes.value, context.policy);
  version.format = document.format;
  if (document.compression !== undefined)
    version.compression = document.compression;
  const outcome =
    "error" in document
      ? failed(document.error)
      : await viewOf({ path, bytes: document.bytes, version }, context);
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
  const role = stateRole(reasons, selectedHomePath(facts, path));
  return {
    path,
    home_path: path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null,
    role:
      facts.sqliteSidecars?.has(path) === true && role === "unrelated"
        ? "application_state"
        : role,
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

const stateLimitations = (policy: DesktopViewPolicy) => [
  "Roles are inferred from state directories, open files, window titles, selected paths and dconf key names; a path can be misattributed.",
  "Views cover retained content only; a file that existed before the capture but outside the content roots has no starting view.",
  `SQLite views list at most ${String(policy.sqlite_rows)} rows of ${String(policy.sqlite_tables)} ordinary tables, text views ${String(policy.text_lines)} lines and XML views ${String(policy.xml_nodes)} nodes; changes between truncated views, or views with an unread table, are marked incomplete. Increase the corresponding --view-policy budget and retry the same capture; no restart is needed.`,
  `Each projected SQLite table view is bounded at sqlite_view_bytes=${String(policy.sqlite_view_bytes)} UTF-8 JSON bytes. A refused table keeps its error; other tables remain readable. Raise sqlite_view_bytes in --view-policy on the next call for that refusal. The separate SQLite worker reply and value/record limits may refuse earlier and are not raised by view policy.`,
  `JSON and key file views read files of at most ${String(policy.parsed_bytes)} bytes and JSON nested at most ${String(policy.json_depth)} levels; only numbers JavaScript holds exactly are admitted. Increase parsed_bytes or json_depth in --view-policy for a budget refusal; byte budgets do not change numeric exactness or Evidence nesting.`,
  "dconf views keep only groups whose path names the application.",
  `Zip views list at most ${String(policy.zip_entries)} entries and read an entry only when unencrypted, stored or deflated, at most ${String(policy.zip_entry_bytes)} bytes and ${String(policy.zip_ratio)} times its compressed size, up to ${String(policy.zip_bytes)} bytes per archive. Increase the corresponding --view-policy budget for a resource refusal; databases and archives inside an archive are not read.`,
  `A gzip file's view is its document's, read only when it is at most ${String(policy.zip_entry_bytes)} bytes and at most ${String(policy.zip_ratio)} times the file's size; a database inside one is not read, nor a gzip file inside an archive.`,
];

/** Read a capture folder into the application's state view. */
const inspectState = async (
  folder: string,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
  options: DesktopStateViewOptions,
): Promise<Evidence> => {
  const policy = desktopViewPolicy(options.viewPolicy);
  const { evidence, capture } = await readDesktopCapture(folder, signal);
  const names = applicationNames(capture);
  const facts = roleFacts(capture);
  const index = indexState(capture);
  const candidates = statePaths(index);
  for (const selected of options.paths ?? [])
    if (!candidates.includes(selected))
      throw new AnalysisInputError(
        OPERATION,
        {
          userMessage: `Captured path ${JSON.stringify(selected)} was not found.`,
          remediationAction:
            "Use an exact path from this capture's state view; no current filesystem path is substituted.",
        },
        [{ path: ["paths"], reason: "invalid_value" }],
      );
  const paths = await withRetainedContent(
    folder,
    async (content) => {
      const context: ViewContext = {
        content,
        readers,
        names,
        signal,
        index,
        policy,
      };
      const described: DesktopStatePath[] = [];
      for (const path of candidates)
        if (options.paths === undefined || options.paths.includes(path))
          described.push(await describePath(capture, path, facts, context));
      return described;
    },
    policy.file_bytes,
  );
  const limitations = [
    ...stateLimitations(policy),
    ...(capture.state.state_directories === undefined
      ? [
          "The capture does not record its state directories as walked, so files in a symlinked state directory may be classed as documents.",
        ]
      : []),
  ];
  const result: DesktopApplicationState = {
    effective_view_policy: policy,
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
  if (signal?.aborted === true)
    throw new AnalysisCancelledError(OPERATION, { cause: signal.reason });
  return createEvidence(undefined, DESKTOP_PROVIDER, {
    predicateType: "rea.desktop-application-state",
    operation: OPERATION,
    parameters: {
      capture_evidence_id: evidence.evidence_id,
      ...(options.viewPolicy === undefined
        ? {}
        : { view_policy: { ...options.viewPolicy } }),
      ...(options.paths === undefined ? {} : { paths: [...options.paths] }),
    },
    result,
    confidence: "inferred",
    authority: "analyst-inference",
    limitations: [...limitations, ...capture.limitations],
  });
};

export interface DesktopStateViewOptions {
  readonly viewPolicy?: DesktopViewPolicyInput | undefined;
  /** Exact original captured paths; omission examines every retained path. */
  readonly paths?: readonly string[] | undefined;
}

/** Inspect one capture folder, returning its state view Evidence or a failure. */
export const inspectDesktopApplicationState = async (
  folder: string,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
  options: DesktopStateViewOptions = {},
): Promise<Evidence | AnalysisError> => {
  try {
    const admitted = desktopViewPolicyInputSchema.safeParse(
      options.viewPolicy === undefined ? {} : options.viewPolicy,
    );
    if (!admitted.success)
      return analysisInputErrorFromIssues(
        OPERATION,
        admitted.error.issues,
        options.viewPolicy,
      );
    return await inspectState(folder, readers, signal, {
      ...options,
      ...(options.viewPolicy === undefined
        ? {}
        : { viewPolicy: admitted.data }),
    });
  } catch (cause: unknown) {
    return desktopOperationFailure(
      cause,
      signal,
      OPERATION,
      "Desktop state view",
    );
  }
};
