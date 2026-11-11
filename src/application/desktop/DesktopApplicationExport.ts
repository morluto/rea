import type { DesktopViewPolicyInput } from "../../domain/desktop/desktopViewPolicy.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import type { DownloadInstall } from "../../domain/desktop/appDownloadInstall.js";
import {
  DESKTOP_EXPORT_FRAMEWORK_VERSION,
  appModuleFile,
  className,
  exportedStateFiles,
  renderAppClass,
  renderEnvToml,
  renderReadme,
  renderSkill,
  renderSmokeTask,
  type DesktopAppExportPlan,
  type HomePathCollision,
  type SeedScrubReport,
} from "../../domain/desktop/appExport.js";
import type { WithheldFile } from "../../domain/desktop/appWithheld.js";
import {
  trashedFiles,
  runtimeSeeds,
  unownedChangedFolders,
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
import { scrubDconf } from "../../domain/desktop/seedScrub.js";
import { createEvidence, type Evidence } from "../../domain/evidence.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { ProviderAdapterError } from "../../domain/providerAdapterError.js";
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
  installFiles,
  readDownloadInstall,
} from "./DesktopExportInstall.js";
import {
  writeOutputTree,
  writtenWithOpenHandles,
} from "./DesktopOutputTree.js";
import {
  retainedCopies,
  writeFiles,
  type SeedVersion,
} from "./DesktopExportFiles.js";
import {
  planWithheld,
  refuseSignInDconf,
  withheldCopy,
  type WithheldRequest,
} from "./DesktopExportWithheld.js";
import { exportLimitations } from "./DesktopExportLimitations.js";
import { withRetainedContent } from "./DesktopRetainedContent.js";
import { planLaunch, seedModes, seedVersions } from "./DesktopExportLaunch.js";
import { selectStateEnds } from "./DesktopStateVersions.js";
import {
  admitDesktopTasks,
  type AdmittedTasks,
  type TaskSummary,
} from "./DesktopTaskExport.js";
import { taskReads } from "./DesktopExportReaders.js";

const OPERATION = "export_desktop_application";
/** Largest seed file the export copies; the state view reads only 64 MiB. */
const SEED_MAX_BYTES = 1024 * 1024 * 1024;

/** What the caller asked to export, after CLI parsing. */
export interface DesktopExportRequest extends WithheldRequest {
  readonly viewPolicy?: DesktopViewPolicyInput | undefined;
  readonly capture: string;
  readonly directory: string;
  readonly name: string | undefined;
  /** Task files to validate and add, each checked at its own end. */
  readonly tasks: readonly string[];
  /** `NAME=CHECKPOINT` for each task checked at a checkpoint other than the end checkpoint. */
  readonly taskEnds?: readonly string[] | undefined;
  /** Where the computer downloads the captured package file from, for an application installed from one. */
  readonly packageUrl?: string | undefined;
  /** Packages installed beside the application, such as a runtime piece a build request named. */
  readonly extraPackages?: readonly string[] | undefined;
  /** A JSON file naming the AppImage or tarball a build computer unpacked the application from. */
  readonly downloadInstall?: string | undefined;
  /** The folder a build computer keeps a screenshot of each checkpoint in, a screen judge's examples. */
  readonly screens?: string | undefined;
  /** The checkpoint the seed is taken at; the baseline when omitted. */
  readonly seedCheckpoint?: string | undefined;
  /** The checkpoint a task's end state is read at unless it names its own; the last when omitted. */
  readonly endCheckpoint?: string | undefined;
  /** The seed was made for the task, as in a build computer, rather than taken from the user's own data. */
  readonly syntheticSeed?: boolean | undefined;
  /** A new or empty folder, outside the bundle, the withheld files are copied into. */
  readonly withheldCopy?: string | undefined;
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
  readonly tasks: readonly TaskSummary[];
  /** Files withheld from the seed, each a secret setting a deploy takes from its environment variable. */
  readonly withheld_files: readonly WithheldFile[];
  /** Withheld files seeded all the same, with the person's consent. */
  readonly consented_files: readonly string[];
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

/** The bundle as decided, with each seed's digest and what it withholds. */
interface PlannedExport {
  readonly plan: DesktopAppExportPlan;
  readonly seeds: ReadonlyMap<string, SeedVersion>;
  /** Every file present at the seed, withheld ones included, and the consent file the bundle ships. */
  readonly held: {
    readonly captured: ReadonlyMap<string, SeedVersion>;
    readonly consent: string | undefined;
  };
  readonly limitations: readonly string[];
  readonly collisions: readonly HomePathCollision[];
  readonly files: ReadonlyMap<string, StatePath>;
  readonly trashed: readonly string[];
  readonly dconf: { readonly groups: number; readonly holdsIdentity: boolean };
}

/** Decide the bundle from the capture and its state view at the seed, with each seed's digest and what it withholds. */
const planExport = async (
  request: DesktopExportRequest,
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
  context: {
    readonly evidenceId: string;
    readonly seed: number;
    readonly identity: HostIdentity;
    readonly download: DownloadInstall | undefined;
  },
): Promise<PlannedExport> => {
  const { application, host } = capture;
  const source = exportEnvironmentName(capture, request.name);
  const { install, windowClass } = admitApplication(capture, source, {
    ...request,
    download: context.download,
  });
  const electron = application.executable.electron_markers.length > 0;
  const stateFiles = exportedStateFiles(capture, state);
  const { homePath, stateAliases, files, collisions, paths, isLeftOut } =
    stateFiles;
  const { text: dconf, ...dconfScrub } = seedDconf(
    state,
    context.seed,
    context.identity,
  );
  const versions = seedVersions(files, paths, context.seed, isLeftOut);
  const app = { app: source, homePath, paths, ...versions };
  const { seeds, textSeeds, ...held } = await planWithheld(
    request,
    capture,
    app,
  );
  refuseSignInDconf(request, state, context.seed);
  const { locks } = versions;
  const unseeded = unseededFiles(capture, homePath, files, {
    paths,
    seed: context.seed,
  });
  const launch = planLaunch(capture, electron, seeds, files);
  const plan: DesktopAppExportPlan = {
    viewPolicy: request.viewPolicy,
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
    ...(install.download === undefined ? {} : { download: install.download }),
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
    stateAliases,
    unseededFiles: unseeded.filter((file) => !isLeftOut(file)),
    leftOutLocks: [
      ...new Set([...locks, ...unseeded.filter(isLeftOut)]),
    ].sort(),
    unownedFolders: unownedChangedFolders(files, paths, isLeftOut),
    runtimeSeeds: runtimeSeeds([...seeds.keys()]),
    dconf,
    captureEvidenceId: context.evidenceId,
    withheld: held.withheld,
    consentedFiles: held.consented,
  };
  const unreadDconf = unreadDconfLimitation(stateFiles.dconf, context.seed);
  const limitations = [
    ...installLimitations(install, application.package, electron),
    ...(unreadDconf === undefined ? [] : [unreadDconf]),
  ];
  return {
    plan,
    seeds,
    held: { captured: versions.seeds, consent: held.consent },
    limitations,
    collisions,
    files,
    trashed: trashedFiles(files, context.seed),
    dconf: dconfScrub,
  };
};

/** The bundle's generated files, the class module flagged when its dconf keys hold the identity, and its README, made once the seeds' scrub is known. */
const bundleText = (
  plan: DesktopAppExportPlan,
  admitted: AdmittedTasks | undefined,
  dconfHoldsIdentity: boolean,
  consent: string | undefined,
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
        renderAppClass({
          ...plan,
          relaunchOnReset: admitted?.screenJudged === true,
        }),
        dconfHoldsIdentity,
      ),
      text(`${environment}/SKILL.md`, renderSkill(plan)),
      ...installFiles(plan).map(({ path, content }) =>
        text(`${environment}/${path}`, content),
      ),
      text("tasks/smoke.json", renderSmokeTask(plan)),
      ...(consent === undefined ? [] : [text("consent.json", consent)]),
      ...(admitted?.files ?? []).map((file) => text(file.path, file.content)),
    ],
  };
};

/** What the scrub reports before it runs. */
const NO_SCRUB: SeedScrubReport = {
  scrubbed: [],
  recompressed: [],
  unscrubbed: [],
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
    { viewPolicy: request.viewPolicy },
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
  const { plan, seeds, held, collisions, files, trashed, dconf, ...install } =
    await planExport(request, capture, state, {
      evidenceId: evidence.evidence_id,
      seed: ends.seed,
      identity,
      download: await readDownloadInstall(request.downloadInstall, signal),
    });
  const copies = retainedCopies(plan, seeds);
  const reads = await taskReads(request, SEED_MAX_BYTES, {
    copies,
    files,
    ends,
    identity,
    checkpoints,
    signal,
  });
  const admitted = await admitDesktopTasks(
    { paths: request.tasks, ends: request.taskEnds ?? [] },
    {
      ...plan,
      files,
      identity,
      ends,
      checkpoints,
      ...reads,
      seeded: new Set(seeds.keys()),
    },
    signal,
  );
  const copy = await withheldCopy(request, plan, held.captured, signal);
  const text = bundleText(plan, admitted, dconf.holdsIdentity, held.consent);
  const { generated, readme } = text;
  let scrub = NO_SCRUB;
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
    files,
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
    tasks: admitted?.summaries ?? [],
    withheld_files: plan.withheld ?? [],
    consented_files: plan.consentedFiles ?? [],
  };
  let copyUnclosed: Awaited<ReturnType<typeof copy.write>> = undefined;
  let copyFailure: { readonly cause: unknown } | undefined;
  try {
    copyUnclosed = await copy.write();
  } catch (cause: unknown) {
    copyFailure = { cause };
  }
  return {
    result,
    captureEvidenceId: evidence.evidence_id,
    unclosed,
    copyUnclosed,
    copyFailure,
  };
};

/** Export one capture folder as an agentenv computer app bundle, reported as Evidence. */
export const exportDesktopApplication = async (
  request: DesktopExportRequest,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
): Promise<Evidence | AnalysisError> => {
  try {
    const { result, captureEvidenceId, unclosed, copyUnclosed, copyFailure } =
      await runExport(request, readers, signal);
    const evidence = createEvidence(undefined, DESKTOP_PROVIDER, {
      predicateType: "rea.desktop-application-export",
      operation: OPERATION,
      parameters: {
        capture_evidence_id: captureEvidenceId,
        named: request.name !== undefined,
        tasks: request.tasks.length,
        task_ends: [...(request.taskEnds ?? [])],
        package_url: request.packageUrl !== undefined,
        download_install: request.downloadInstall !== undefined,
        extra_packages: [...(request.extraPackages ?? [])],
        seed_checkpoint: request.seedCheckpoint ?? null,
        end_checkpoint: request.endCheckpoint ?? null,
        synthetic_seed: request.syntheticSeed === true,
        withhold_from: request.withhold?.from ?? null,
        withhold_to: request.withhold?.to ?? null,
        withhold_paths: [...(request.withhold?.paths ?? [])],
        seed_withheld: request.seedWithheld === true,
        ...(request.viewPolicy === undefined
          ? {}
          : { view_policy: { ...request.viewPolicy } }),
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
        withheld_files: result.withheld_files.map((file) => ({ ...file })),
        consented_files: [...result.consented_files],
      },
      confidence: "derived",
      authority: "analyst-inference",
      limitations: [...result.limitations],
    });
    if (copyFailure !== undefined) {
      const failure = desktopOperationFailure(
        copyFailure.cause,
        signal,
        OPERATION,
        "Desktop export",
      );
      failure.retainPartialObservation(evidence);
      if (unclosed === undefined) return failure;
      const cleanup = writtenWithOpenHandles(
        { provider: DESKTOP_PROVIDER.id, operation: OPERATION, what: "bundle" },
        request.directory,
        unclosed,
        evidence,
      );
      const combined = new ProviderAdapterError(
        DESKTOP_PROVIDER.id,
        OPERATION,
        {
          cause: failure,
          cleanupPrimary: failure,
          partialObservation: evidence,
          userMessage: `The bundle was written to ${request.directory}, but the withheld copy failed and bundle handles could not be closed.`,
          cleanup: {
            reason: "Bundle output handles could not be closed.",
            resources: [request.directory],
          },
        },
      );
      combined.retainSecondaryFailure(cleanup);
      combined.bindCleanupDependencies([cleanup, failure]);
      return combined;
    }
    const open = [
      { what: "bundle", directory: request.directory, release: unclosed },
      {
        what: "withheld copy",
        directory: request.withheldCopy ?? "",
        release: copyUnclosed,
      },
    ].flatMap(({ release, ...written }) =>
      release === undefined ? [] : [{ ...written, release }],
    );
    if (open.length === 0) return evidence;
    const failures = open.map(({ what, directory, release }) =>
      writtenWithOpenHandles(
        { provider: DESKTOP_PROVIDER.id, operation: OPERATION, what },
        directory,
        release,
        evidence,
      ),
    );
    if (failures.length === 1) return failures[0]!;
    const combined = new ProviderAdapterError(DESKTOP_PROVIDER.id, OPERATION, {
      userMessage:
        "The bundle and withheld copy were written, but their output handles could not be closed.",
      partialObservation: evidence,
      cleanup: {
        reason: "Output handles could not be closed.",
        resources: open.map(({ directory }) => directory),
      },
    });
    for (const failure of failures) combined.retainSecondaryFailure(failure);
    combined.bindCleanupDependencies(failures);
    return combined;
  } catch (cause: unknown) {
    return desktopOperationFailure(cause, signal, OPERATION, "Desktop export");
  }
};
