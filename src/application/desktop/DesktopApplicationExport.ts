import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  DESKTOP_EXPORT_FRAMEWORK_VERSION,
  appModuleFile,
  className,
  exportedStateFiles,
  launchDocumentLimitation,
  renderAppClass,
  renderEnvToml,
  renderInstallScript,
  renderReadme,
  renderSkill,
  renderSmokeTask,
  type DesktopAppExportPlan,
  type HomePathCollision,
  type SeedScrubReport,
} from "../../domain/desktop/appExport.js";
import { INSTALL_SCRIPT } from "../../domain/desktop/appExportInstall.js";
import {
  heldOpenLimitation,
  leftOutLocksLimitation,
  leftOutLogsLimitation,
  leftOutSeeds,
  trashedFiles,
  runtimeSeeds,
  runtimeSeedsLimitation,
  unownedChangedFolders,
  unownedFoldersLimitation,
  unreadDconfLimitation,
} from "../../domain/desktop/appExportUnowned.js";
import { installLimitations } from "../../domain/desktop/appExportInstallLimitations.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import {
  desktopApplicationStateSchema,
  versionAt,
  type DesktopApplicationState,
} from "../../domain/desktop/desktopState.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import type { HostIdentity } from "../../domain/desktop/hostIdentity.js";
import { recoveryListLimitation } from "../../domain/desktop/seedRecoveryList.js";
import { scrubDconf } from "../../domain/desktop/seedScrub.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
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
  admitApplication,
  exportEnvironmentName,
} from "./DesktopExportInstall.js";
import {
  writeOutputTree,
  writtenWithOpenHandles,
} from "./DesktopOutputTree.js";
import {
  retainedCopies,
  shippedSeedViews,
  writeFiles,
  type SeedVersion,
} from "./DesktopExportFiles.js";
import { withRetainedContent } from "./DesktopRetainedContent.js";
import { planLaunch, seedModes, seedVersions } from "./DesktopExportLaunch.js";
import { selectStateEnds } from "./DesktopStateVersions.js";
import { admitDesktopTask, type AdmittedTask } from "./DesktopTaskExport.js";

const OPERATION = "export_desktop_application";
/** Largest seed file the export copies; the state view reads only 64 MiB. */
const SEED_MAX_BYTES = 1024 * 1024 * 1024;

/** What the caller asked to export, after CLI parsing. */
export interface DesktopExportRequest {
  readonly capture: string;
  readonly directory: string;
  readonly name: string | undefined;
  /** Task files to validate and add; a capture yields at most one. */
  readonly tasks: readonly string[];
  /** Where the computer downloads the captured package file from, for an application installed from one. */
  readonly packageUrl?: string | undefined;
  /** Packages installed beside the application, such as a runtime piece a build request named. */
  readonly extraPackages?: readonly string[] | undefined;
  /** The checkpoint the seed is taken at; the baseline when omitted. */
  readonly seedCheckpoint?: string | undefined;
  /** The checkpoint a task's end state is read at; the last when omitted. */
  readonly endCheckpoint?: string | undefined;
  /** The seed was made for the task, as in a build computer, rather than taken from the user's own data. */
  readonly syntheticSeed?: boolean | undefined;
}

/** What the export wrote. */
export interface DesktopExportResult {
  readonly directory: string;
  readonly environment: string;
  readonly framework_version: string;
  readonly checkpoints: { readonly seed: string; readonly end: string };
  readonly paths: readonly string[];
  readonly seed_files: readonly string[];
  readonly unseeded_files: readonly string[];
  /** Seed files rewritten to remove the capture host's name and user. */
  readonly scrubbed_files: readonly string[];
  /** gzip seed files compressed again only to clear their headers, their documents as captured. */
  readonly recompressed_files: readonly string[];
  /** Seed files that still hold them, in bytes the export does not rewrite or in their name. */
  readonly unscrubbed_files: readonly string[];
  readonly dconf_groups: number;
  readonly files: readonly string[];
  readonly limitations: readonly string[];
  readonly task: AdmittedTask["summary"] | null;
}

const isRecord = (
  value: JsonValue | null | undefined,
): value is Record<string, JsonValue> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The application's dconf groups at the seed, as a dconf key file with the identity scrubbed from its strings. */
const seedDconf = (
  state: DesktopApplicationState,
  seed: number,
  identity: HostIdentity,
): { text: string; groups: number; holdsIdentity: boolean } => {
  const database = state.paths.find(
    (path) => path.format === "dconf" && path.role === "application_state",
  );
  const version =
    database === undefined ? undefined : versionAt(database, seed);
  const view = version?.view;
  if (version?.present !== true || !isRecord(view) || !isRecord(view.groups))
    return { text: "", groups: 0, holdsIdentity: false };
  const groups = Object.keys(view.groups).length;
  return { ...scrubDconf(view.groups, identity), groups };
};

type StatePath = DesktopApplicationState["paths"][number];
/** Files under the owned paths that existed at the seed without retained bytes, in the state view or omitted. */
const unseededFiles = (
  capture: DesktopApplicationCapture,
  homePath: (path: string) => string | null,
  files: ReadonlyMap<string, StatePath>,
  { paths, seed }: { readonly paths: readonly string[]; readonly seed: number },
): readonly string[] => {
  const listed = [...files]
    .filter(([home, path]) => {
      const version = versionAt(path, seed);
      return (
        isWithinAny(home, paths) &&
        version?.present === true &&
        version.sha256 === null
      );
    })
    .map(([home]) => home);
  const omitted = capture.state.omitted_content
    .map(({ path }) => homePath(path))
    .filter(
      (home): home is string =>
        home !== null && isWithinAny(home, paths) && !files.has(home),
    );
  return [...new Set([...listed, ...omitted])].sort();
};

/** Decide the bundle from the capture and its state view at the seed, with each seed's digest. */
const planExport = (
  request: DesktopExportRequest,
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
  context: {
    readonly evidenceId: string;
    readonly seed: number;
    readonly identity: HostIdentity;
  },
): {
  readonly plan: DesktopAppExportPlan;
  readonly seeds: ReadonlyMap<string, SeedVersion>;
  readonly limitations: readonly string[];
  readonly collisions: readonly HomePathCollision[];
  readonly files: ReadonlyMap<string, StatePath>;
  readonly trashed: readonly string[];
  readonly dconf: { readonly groups: number; readonly holdsIdentity: boolean };
} => {
  const { application, host } = capture;
  const source = exportEnvironmentName(capture, request.name);
  const { install, windowClass } = admitApplication(
    capture,
    source,
    request.packageUrl,
    request.extraPackages,
  );
  const electron = application.executable.electron_markers.length > 0;
  const stateFiles = exportedStateFiles(capture, state);
  const { homePath, files, collisions, paths, isLeftOut } = stateFiles;
  const { text: dconf, ...dconfScrub } = seedDconf(
    state,
    context.seed,
    context.identity,
  );
  const { seeds, textSeeds, locks } = seedVersions(
    files,
    paths,
    context.seed,
    isLeftOut,
  );
  const unseeded = unseededFiles(capture, homePath, files, {
    paths,
    seed: context.seed,
  });
  const launch = planLaunch(capture, electron, seeds, files);
  const plan: DesktopAppExportPlan = {
    name: source,
    className: className(source),
    title: application.desktop_entry?.name ?? source,
    aptPackage: install.aptPackage,
    aptRelease: install.release,
    packageVersion: application.package.version,
    libraryPackages: install.libraryPackages,
    aptSources: install.sources,
    architectures: install.architectures,
    packageFile: install.packageFile,
    ...(install.executablePackage === undefined
      ? {}
      : { executablePackage: install.executablePackage }),
    ...(install.extraPackages === undefined
      ? {}
      : { extraPackages: install.extraPackages }),
    electron,
    command: launch.command,
    opens: launch.opens,
    windowClass,
    paths,
    capturedHome: host.home,
    seedCheckpoint: state.capture.checkpoints[context.seed] ?? "baseline",
    syntheticSeed: request.syntheticSeed === true,
    seedFiles: [...seeds.keys()].sort(),
    textSeeds,
    seedModes: seedModes(capture, seeds, files, context.seed),
    unseededFiles: unseeded.filter((file) => !isLeftOut(file)),
    ...leftOutSeeds(
      [...locks, ...unseeded.filter(isLeftOut)],
      stateFiles.isLeftOutLog,
    ),
    unownedFolders: unownedChangedFolders(files, paths, isLeftOut),
    runtimeSeeds: runtimeSeeds([...seeds.keys()]),
    dconf,
    captureEvidenceId: context.evidenceId,
  };
  const unreadDconf = unreadDconfLimitation(stateFiles.dconf, context.seed);
  const limitations = [
    ...installLimitations(install, application.package, electron),
    ...(unreadDconf === undefined ? [] : [unreadDconf]),
  ];
  return {
    plan,
    seeds,
    limitations,
    collisions,
    files,
    trashed: trashedFiles(files, context.seed),
    dconf: dconfScrub,
  };
};

/** The limitation on where the seed came from: made for the task, or the user's real state, kept local. */
export const seedLimitation = (syntheticSeed: boolean): string =>
  syntheticSeed
    ? "The seed was made for the task, not taken from a user's own data; read it before publishing the bundle."
    : "The seed is the user's real state at the seed checkpoint; keep the bundle local.";

const SCRUB_LIMITATION =
  "Binary state files are seeded as captured; only text files, UTF-8 or UTF-16 with a byte-order mark, and gzip documents, scrubbed inside, have the capture host's name, user@host and home path replaced. A gzip document so rewritten is compressed again as one member with no extra field, so a BGZF or dictzip file loses the blocks its index names.";

/** The bundle's generated files, the class module flagged when its dconf keys hold the identity, and its README, made once the seeds' scrub is known. */
const bundleText = (
  plan: DesktopAppExportPlan,
  admitted: AdmittedTask | undefined,
  dconfHoldsIdentity: boolean,
) => {
  const environment = `envs/${plan.name}`;
  const text = (path: string, content: string, holdsIdentity = false) => ({
    path,
    bytes: Buffer.from(content),
    holdsIdentity,
  });
  return {
    readme: (scrub: SeedScrubReport) =>
      text("README.md", renderReadme(plan, admitted?.readme, scrub)),
    generated: [
      text(`${environment}/env.toml`, renderEnvToml(plan)),
      text(
        `${environment}/${appModuleFile(plan.name)}`,
        renderAppClass(plan),
        dconfHoldsIdentity,
      ),
      text(`${environment}/SKILL.md`, renderSkill(plan)),
      ...(plan.packageFile === null
        ? []
        : [
            text(
              `${environment}/${INSTALL_SCRIPT}`,
              renderInstallScript(plan.packageFile),
            ),
          ]),
      text("tasks/smoke.json", renderSmokeTask(plan)),
      ...(admitted?.files ?? []).map((file) => text(file.path, file.content)),
    ],
  };
};

const exportLimitations = (
  capture: DesktopApplicationCapture,
  plan: DesktopAppExportPlan,
  facts: {
    readonly install: readonly string[];
    readonly collisions: readonly HomePathCollision[];
    readonly identity: HostIdentity;
    readonly trashed: readonly string[];
    readonly recovered: readonly string[];
    /** What the export says about the task, such as a prompt that does not name the app. */
    readonly task: readonly string[];
  },
): string[] => {
  const opened = heldOpenLimitation(
    capture.state.unretained_opened_directories,
    capture.host.home,
    plan.seedFiles,
  );
  const opens = launchDocumentLimitation(plan.opens);
  const unowned = unownedFoldersLimitation(plan.unownedFolders);
  const runtime = runtimeSeedsLimitation(plan.runtimeSeeds);
  const locks = leftOutLocksLimitation(plan.leftOutLocks);
  const logs = leftOutLogsLimitation(plan.leftOutLogs);
  const recovered = recoveryListLimitation(facts.recovered);
  return [
    seedLimitation(plan.syntheticSeed),
    SCRUB_LIMITATION,
    ...(opens === undefined ? [] : [opens]),
    ...facts.install,
    ...(plan.unseededFiles.length === 0
      ? []
      : [
          `${String(plan.unseededFiles.length)} file(s) under the owned paths existed at the seed but were not retained, so they are not seeded.`,
        ]),
    ...(locks === undefined ? [] : [locks]),
    ...(logs === undefined ? [] : [logs]),
    ...(recovered === undefined ? [] : [recovered]),
    ...(unowned === undefined ? [] : [unowned]),
    ...(runtime === undefined ? [] : [runtime]),
    ...(facts.trashed.length === 0
      ? []
      : [
          `The desktop Trash held ${String(facts.trashed.length)} file(s) at the seed checkpoint, which are not seeded: ${facts.trashed.map((home) => `~/${home}`).join(", ")}. Restore one the task needs and capture again.`,
        ]),
    ...(facts.identity.hostname === null || facts.identity.user === null
      ? [
          "The capture does not record the host's name and user, so only the captured home is removed from the seed; capture again to remove them too.",
        ]
      : []),
    ...(opened === undefined ? [] : [opened]),
    ...facts.collisions.map(
      ({ home, kept, dropped }) =>
        `${dropped} and ${kept} both map to ~/${home}; the export uses ${kept} and leaves out ${dropped}.`,
    ),
    ...facts.task,
  ];
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
  const { checkpoints } = state.capture;
  const ends = selectStateEnds(
    checkpoints,
    { seed: request.seedCheckpoint, end: request.endCheckpoint },
    OPERATION,
  );
  const { home, hostname, user } = capture.host;
  const identity = { home, hostname: hostname ?? null, user: user ?? null };
  const { plan, seeds, collisions, files, trashed, dconf, ...install } =
    planExport(request, capture, state, {
      evidenceId: evidence.evidence_id,
      seed: ends.seed,
      identity,
    });
  const copies = retainedCopies(plan, seeds);
  // A task's seed checks read the seeds as the bundle ships them, scrubbed.
  const seedViews =
    request.tasks.length === 0
      ? new Map()
      : await withRetainedContent(
          request.capture,
          (content) => shippedSeedViews(content, copies, identity, signal),
          SEED_MAX_BYTES,
        );
  const admitted = await admitDesktopTask(
    request.tasks,
    { ...plan, files, identity, ends, seedViews },
    signal,
  );
  const { generated, readme } = bundleText(plan, admitted, dconf.holdsIdentity);
  let scrub: SeedScrubReport = {
    scrubbed: [],
    recompressed: [],
    unscrubbed: [],
  };
  const unclosed = await withRetainedContent(
    request.capture,
    (content) =>
      writeOutputTree(
        request.directory,
        async (tree) => {
          const bundle = { generated, copies, identity, readme };
          scrub = await writeFiles(tree, content, bundle, signal);
        },
        { operation: OPERATION, field: "directory" },
        signal,
      ),
    SEED_MAX_BYTES,
  );
  const limitations = exportLimitations(capture, plan, {
    install: install.limitations,
    collisions,
    identity,
    trashed,
    recovered: scrub.recovered ?? [],
    task: admitted?.limitations ?? [],
  });
  const result: DesktopExportResult = {
    directory: request.directory,
    environment: plan.name,
    framework_version: DESKTOP_EXPORT_FRAMEWORK_VERSION,
    checkpoints: {
      seed: checkpoints[ends.seed] ?? "baseline",
      end: checkpoints[ends.end] ?? "baseline",
    },
    paths: plan.paths,
    seed_files: plan.seedFiles,
    unseeded_files: plan.unseededFiles,
    scrubbed_files: [...scrub.scrubbed].sort(),
    recompressed_files: [...scrub.recompressed].sort(),
    unscrubbed_files: [...scrub.unscrubbed].sort(),
    dconf_groups: dconf.groups,
    files: [
      "README.md",
      ...generated.map((file) => file.path),
      ...copies.map((copy) => copy.path),
    ],
    limitations,
    task: admitted?.summary ?? null,
  };
  return { result, captureEvidenceId: evidence.evidence_id, unclosed };
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
        tasks: request.tasks.length,
        package_url: request.packageUrl !== undefined,
        extra_packages: [...(request.extraPackages ?? [])],
        seed_checkpoint: request.seedCheckpoint ?? null,
        end_checkpoint: request.endCheckpoint ?? null,
        synthetic_seed: request.syntheticSeed === true,
      },
      result: {
        ...result,
        checkpoints: { ...result.checkpoints },
        paths: [...result.paths],
        seed_files: [...result.seed_files],
        unseeded_files: [...result.unseeded_files],
        scrubbed_files: [...result.scrubbed_files],
        recompressed_files: [...result.recompressed_files],
        unscrubbed_files: [...result.unscrubbed_files],
        files: [...result.files],
        limitations: [...result.limitations],
      },
      confidence: "derived",
      authority: "analyst-inference",
      limitations: [...result.limitations],
    });
    return unclosed === undefined
      ? evidence
      : writtenWithOpenHandles(
          {
            provider: DESKTOP_PROVIDER.id,
            operation: OPERATION,
            what: "bundle",
          },
          request.directory,
          unclosed,
          evidence,
        );
  } catch (cause: unknown) {
    return desktopOperationFailure(cause, signal, OPERATION, "Desktop export");
  }
};
