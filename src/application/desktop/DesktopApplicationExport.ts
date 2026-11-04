import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  ArtifactResourceScope,
  type ArtifactCleanupAttempt,
} from "../../artifacts/ArtifactResourceScope.js";
import { outputDirectoryAdmissionRefusal } from "../../artifacts/SafeOutputTreeAdmission.js";
import { SafeOutputTreeCreationFailure } from "../../artifacts/SafeOutputTreeCreationFailure.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  DESKTOP_EXPORT_FRAMEWORK_VERSION,
  appModuleFile,
  className,
  environmentName,
  launchCommand,
  ownedPaths,
  renderAppClass,
  renderEnvToml,
  renderReadme,
  renderSkill,
  renderSmokeTask,
  type DesktopAppExportPlan,
} from "../../domain/desktop/appExport.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import {
  desktopApplicationStateSchema,
  type DesktopApplicationState,
} from "../../domain/desktop/desktopState.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { isPortableBundleName } from "../environment/environmentBundle.js";
import {
  inspectDesktopApplicationState,
  readDesktopCapture,
  type DesktopStateReaders,
} from "./DesktopApplicationState.js";
import {
  DESKTOP_PROVIDER,
  desktopOperationFailure,
} from "./DesktopCaptureRefusals.js";
import {
  withRetainedContent,
  type RetainedContent,
} from "./DesktopRetainedContent.js";

const OPERATION = "export_desktop_application";
/**
 * The computer base is Ubuntu 24.04, so only its archive's packages install by
 * name: an Ubuntu archive or mirror serving a noble suite and an Ubuntu
 * component, but not a Launchpad PPA.
 */
const UBUNTU_NOBLE_SOURCE =
  /^\S+:\/\/(?!ppa\.launchpad(?:content)?\.net\/)\S*ubuntu\S* noble(?:-updates|-security|-backports)?\/(?:main|restricted|universe|multiverse) /u;
/** Largest seed file the export copies; the state view reads only 64 MiB. */
const SEED_MAX_BYTES = 1024 * 1024 * 1024;
const TEXT_FORMATS = new Set(["text", "json", "keyfile", "xml"]);

/** What the caller asked to export, after CLI parsing. */
export interface DesktopExportRequest {
  readonly capture: string;
  readonly directory: string;
  readonly name: string | undefined;
}

/** What the export wrote. */
export interface DesktopExportResult {
  readonly directory: string;
  readonly environment: string;
  readonly framework_version: string;
  readonly paths: readonly string[];
  readonly seed_files: readonly string[];
  readonly unseeded_files: readonly string[];
  readonly dconf_groups: number;
  readonly files: readonly string[];
  readonly limitations: readonly string[];
}

const refuse = (
  userMessage: string,
  field: string,
  remediationAction: string,
) =>
  new AnalysisInputError(
    OPERATION,
    { userMessage, remediationAction, conformsToInputContract: true },
    [{ path: [field], reason: "invalid_value", message: userMessage }],
  );

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The application's dconf groups at the baseline, as a dconf key file. */
const baselineDconf = (
  state: DesktopApplicationState,
): { text: string; groups: number } => {
  const database = state.paths.find(
    (path) => path.format === "dconf" && path.role === "application_state",
  );
  const view = database?.versions.find((version) => version.present)?.view;
  if (
    database?.versions[0]?.present !== true ||
    !isRecord(view) ||
    !isRecord(view.groups)
  )
    return { text: "", groups: 0 };
  const lines: string[] = [];
  for (const [group, keys] of Object.entries(view.groups)) {
    if (!isRecord(keys)) continue;
    lines.push(`[${group}]`);
    for (const [key, value] of Object.entries(keys))
      if (typeof value === "string") lines.push(`${key}=${value}`);
    lines.push("");
  }
  return { text: lines.join("\n"), groups: Object.keys(view.groups).length };
};

type StatePath = DesktopApplicationState["paths"][number];
type FailedRelease = Extract<
  ArtifactCleanupAttempt,
  { readonly kind: "failed" }
>;

const homeRelative = (home: string, path: string) =>
  path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;

/** A capture path in its logical spelling; the capture lists physical state directories in the logical ones' order. */
const logicalSpelling = (capture: DesktopApplicationCapture) => {
  const logical = capture.application.state_directories;
  const renamed = (capture.state.state_directories ?? []).flatMap(
    (physical, index) => {
      const path = logical[index]?.path;
      return path === undefined || path === physical
        ? []
        : [{ physical, logical: path }];
    },
  );
  return (path: string): string => {
    const directory = renamed.find(({ physical }) =>
      isWithinAny(path, [physical]),
    );
    return directory === undefined
      ? path
      : `${directory.logical}${path.slice(directory.physical.length)}`;
  };
};

/** The state view's files by logical home path; dconf databases are settings, not files. */
const filesByHomePath = (
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
): ReadonlyMap<string, StatePath> => {
  const spell = logicalSpelling(capture);
  const files = new Map<string, StatePath>();
  for (const path of state.paths) {
    const home = homeRelative(capture.host.home, spell(path.path));
    if (home !== null && path.format !== "dconf") files.set(home, path);
  }
  return files;
};

/** Files under the owned paths that existed before the capture without retained bytes, in the state view or omitted. */
const unseededFiles = (
  capture: DesktopApplicationCapture,
  files: ReadonlyMap<string, StatePath>,
  paths: readonly string[],
): readonly string[] => {
  const spell = logicalSpelling(capture);
  const listed = [...files]
    .filter(
      ([home, path]) =>
        isWithinAny(home, paths) &&
        path.versions[0]?.present === true &&
        path.versions[0].sha256 === null,
    )
    .map(([home]) => home);
  const omitted = capture.state.omitted_content
    .map(({ path }) => homeRelative(capture.host.home, spell(path)))
    .filter(
      (home): home is string =>
        home !== null && isWithinAny(home, paths) && !files.has(home),
    );
  return [...new Set([...listed, ...omitted])].sort();
};

/** Refuse what v1 cannot install or tell ready; the apt package and window class to declare. */
const admitApplication = (capture: DesktopApplicationCapture) => {
  const installed = capture.application.package;
  if (
    installed.kind !== "deb" ||
    installed.name === null ||
    !installed.sources.some((source) => UBUNTU_NOBLE_SOURCE.test(source))
  )
    throw refuse(
      `The application is not installed from the Ubuntu 24.04 package archive (${installed.kind}${installed.name === null ? "" : ` ${installed.name}`}; sources: ${installed.sources.join(", ") || "none"}), so the computer cannot install it.`,
      "capture",
      "Capture an application installed with apt from the Ubuntu 24.04 archive.",
    );
  const window = capture.session.window_match;
  if (window === null)
    throw refuse(
      "The capture saw no application window, so the export cannot match the app's window to tell when it is ready.",
      "capture",
      "Capture again and wait for the application window to open.",
    );
  return {
    aptPackage: installed.name.split(":")[0] ?? installed.name,
    windowClass: window.class,
  };
};

/** Decide the bundle from the capture and its state view, with each seed's digest. */
const planExport = (
  request: DesktopExportRequest,
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
  evidenceId: string,
): {
  readonly plan: DesktopAppExportPlan;
  readonly seeds: ReadonlyMap<string, string>;
} => {
  const { application, host } = capture;
  const { aptPackage, windowClass } = admitApplication(capture);
  const source =
    request.name ??
    environmentName(
      application.desktop_entry?.id ??
        application.executable.path.split("/").at(-1) ??
        "app",
      isPortableBundleName,
    );
  if (!isPortableBundleName(source))
    throw refuse(
      `${source} is not a portable environment name.`,
      "name",
      "Pass --name with lowercase letters, digits and hyphens.",
    );
  const files = filesByHomePath(capture, state);
  const withRole = (role: string) =>
    [...files].filter(([, path]) => path.role === role).map(([home]) => home);
  const paths = ownedPaths(
    withRole("application_state"),
    withRole("document"),
    application.state_directories
      .map((entry) => homeRelative(host.home, entry.path))
      .filter((path): path is string => path !== null),
  );
  const seeds = new Map<string, string>();
  const textSeeds: string[] = [];
  for (const [home, path] of files) {
    const baseline = path.versions[0];
    if (!isWithinAny(home, paths) || baseline?.present !== true) continue;
    if (baseline.sha256 === null) continue;
    seeds.set(home, baseline.sha256);
    if (TEXT_FORMATS.has(baseline.format ?? "")) textSeeds.push(home);
  }
  const plan: DesktopAppExportPlan = {
    name: source,
    className: className(source),
    title: application.desktop_entry?.name ?? source,
    aptPackage,
    packageVersion: application.package.version,
    command: launchCommand(
      application.argv,
      host.home,
      application.working_directory,
    ),
    windowClass,
    paths,
    capturedHome: host.home,
    seedFiles: [...seeds.keys()].sort(),
    textSeeds: textSeeds.sort(),
    unseededFiles: unseededFiles(capture, files, paths),
    dconf: baselineDconf(state).text,
    captureEvidenceId: evidenceId,
  };
  return { plan, seeds };
};

const EXPORT_LIMITATIONS = [
  "The seed is the user's real state before the capture; keep the bundle local.",
  "The application is installed from the distribution archive by name, so the computer may install a different version than the one captured.",
  "Binary state files are seeded as captured; only text files have the captured home path respelled.",
];

/**
 * Write the bundle through the safe output tree, rolling an unpublished tree
 * back on any failure so no partial copy of the user's data remains. A
 * published bundle is kept; a failed release of its handles is returned.
 */
const writeBundle = async (
  directory: string,
  write: (tree: SafeOutputTree) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<FailedRelease | undefined> => {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  const resources = new ArtifactResourceScope();
  let tree: SafeOutputTree | undefined;
  let outcome:
    | { readonly kind: "completed" }
    | { readonly kind: "failed"; readonly cause: unknown };
  try {
    try {
      tree = await SafeOutputTree.create(directory, process.platform, {
        acceptExistingEmpty: true,
      });
    } catch (cause: unknown) {
      if (cause instanceof SafeOutputTreeCreationFailure) tree = cause.tree;
      throw cause;
    }
    await write(tree);
    await tree.commit(signal);
    outcome = { kind: "completed" };
  } catch (cause: unknown) {
    outcome = { kind: "failed", cause };
  }
  if (tree !== undefined) {
    const released = await resources.release({
      kind: "output-tree",
      resource: directory,
      tree,
    });
    if (released.kind === "failed") {
      if (tree.published) return released;
      throw resources.cleanupFailure(outcome, [released]);
    }
    if (tree.published) return undefined;
  }
  if (outcome.kind === "failed")
    throw outputDirectoryAdmissionRefusal(
      OPERATION,
      "directory",
      outcome.cause,
    );
  return undefined;
};

/** The generated files, and the digest of each seed by its home path. */
interface ExportBundle {
  readonly plan: DesktopAppExportPlan;
  readonly seeds: ReadonlyMap<string, string>;
  readonly generated: readonly {
    readonly path: string;
    readonly bytes: Buffer;
  }[];
}

const seedPath = (plan: DesktopAppExportPlan, seed: string) =>
  `envs/${plan.name}/seed/${seed}`;

/** Write the generated files, then each seed as it is read, so one seed at a time is in memory. */
const writeFiles = async (
  tree: SafeOutputTree,
  content: RetainedContent,
  bundle: ExportBundle,
  signal: AbortSignal | undefined,
): Promise<void> => {
  for (const file of bundle.generated) {
    const sha256 = createHash("sha256").update(file.bytes).digest("hex");
    await tree.write(
      file.path,
      Readable.from([file.bytes]),
      { bytes: file.bytes.length, sha256 },
      signal,
    );
  }
  for (const [seed, digest] of bundle.seeds) {
    signal?.throwIfAborted();
    const bytes = await content.read(digest, signal);
    if (bytes === undefined)
      throw refuse(
        `The retained content of ~/${seed} is missing, larger than the export's 1 GiB seed limit, or does not match its digest.`,
        "capture",
        "Capture the application again, or leave the file out of its state paths.",
      );
    await tree.write(
      seedPath(bundle.plan, seed),
      Readable.from([bytes]),
      { bytes: bytes.length, sha256: digest },
      signal,
    );
  }
};

const runExport = async (
  request: DesktopExportRequest,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
) => {
  const { evidence, capture } = await readDesktopCapture(
    request.capture,
    signal,
  );
  const stateEvidence = await inspectDesktopApplicationState(
    request.capture,
    readers,
    signal,
  );
  if (stateEvidence instanceof AnalysisError) throw stateEvidence;
  const state = desktopApplicationStateSchema.parse(
    stateEvidence.normalized_result,
  );
  const { plan, seeds } = planExport(
    request,
    capture,
    state,
    evidence.evidence_id,
  );
  const environment = `envs/${plan.name}`;
  const text = (path: string, content: string) => ({
    path,
    bytes: Buffer.from(content),
  });
  const generated = [
    text("README.md", renderReadme(plan)),
    text(`${environment}/env.toml`, renderEnvToml(plan)),
    text(`${environment}/${appModuleFile(plan.name)}`, renderAppClass(plan)),
    text(`${environment}/SKILL.md`, renderSkill(plan)),
    text("tasks/smoke.json", renderSmokeTask(plan)),
  ];
  const unclosed = await withRetainedContent(
    request.capture,
    (content) =>
      writeBundle(
        request.directory,
        (tree) => writeFiles(tree, content, { plan, seeds, generated }, signal),
        signal,
      ),
    SEED_MAX_BYTES,
  );
  const opened = capture.state.unretained_opened_directories;
  const limitations = [
    ...EXPORT_LIMITATIONS,
    ...(plan.unseededFiles.length === 0
      ? []
      : [
          `${String(plan.unseededFiles.length)} file(s) under the owned paths existed before the capture but were not retained, so they are not seeded.`,
        ]),
    ...(opened.length === 0
      ? []
      : [
          `The application held files open in ${opened.join(", ")}, whose starting content the capture did not retain, so nothing there is seeded.`,
        ]),
  ];
  const result: DesktopExportResult = {
    directory: request.directory,
    environment: plan.name,
    framework_version: DESKTOP_EXPORT_FRAMEWORK_VERSION,
    paths: plan.paths,
    seed_files: plan.seedFiles,
    unseeded_files: plan.unseededFiles,
    dconf_groups: baselineDconf(state).groups,
    files: [
      ...generated.map((file) => file.path),
      ...plan.seedFiles.map((seed) => seedPath(plan, seed)),
    ],
    limitations,
  };
  return { result, captureEvidenceId: evidence.evidence_id, unclosed };
};

/** A complete bundle whose output handles could not be closed, reported with its Evidence. */
const writtenWithOpenHandles = (
  directory: string,
  evidence: Evidence,
  release: FailedRelease,
): ProviderAdapterError => {
  const reason =
    release.cause instanceof Error
      ? release.cause.message
      : String(release.cause);
  const error = new ProviderAdapterError(DESKTOP_PROVIDER.id, OPERATION, {
    userMessage: `The bundle was written to ${directory} and is complete, but its output handles could not be closed: ${reason}.`,
    remediationAction:
      "Use the written bundle; the handles are released when this process exits.",
    cleanup: { reason, resources: [directory] },
    partialObservation: evidence,
    diagnostics: { output_directory: directory },
  });
  release.lease.bindCleanupError(error);
  return error;
};

/** Export one capture folder as an agentenv computer app bundle, reported as Evidence. */
export const exportDesktopApplication = async (
  request: DesktopExportRequest,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
): Promise<Evidence | AnalysisError> => {
  try {
    const { result, captureEvidenceId, unclosed } = await runExport(
      request,
      readers,
      signal,
    );
    const evidence = createEvidence(undefined, DESKTOP_PROVIDER, {
      predicateType: "rea.desktop-application-export",
      operation: OPERATION,
      parameters: {
        capture_evidence_id: captureEvidenceId,
        named: request.name !== undefined,
      },
      result: {
        ...result,
        paths: [...result.paths],
        seed_files: [...result.seed_files],
        unseeded_files: [...result.unseeded_files],
        files: [...result.files],
        limitations: [...result.limitations],
      },
      confidence: "derived",
      authority: "analyst-inference",
      limitations: [...result.limitations],
    });
    return unclosed === undefined
      ? evidence
      : writtenWithOpenHandles(request.directory, evidence, unclosed);
  } catch (cause: unknown) {
    return desktopOperationFailure(cause, signal, OPERATION, "Desktop export");
  }
};
