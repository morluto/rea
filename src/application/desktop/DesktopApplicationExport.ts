import { AnalysisError } from "../../domain/analysisErrorBase.js";
import {
  DESKTOP_EXPORT_FRAMEWORK_VERSION,
  appModuleFile,
  className,
  exportedStateFiles,
  launchCommand,
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
import {
  INSTALL_SCRIPT,
  electronLaunchArguments,
} from "../../domain/desktop/appExportInstall.js";
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
import { isTextualFormat } from "../../domain/desktop/stateFormats.js";
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
  /** The checkpoint the seed is taken at; the baseline when omitted. */
  readonly seedCheckpoint?: string | undefined;
  /** The checkpoint a task's end state is read at; the last when omitted. */
  readonly endCheckpoint?: string | undefined;
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
  readonly dconf: { readonly groups: number; readonly holdsIdentity: boolean };
} => {
  const { application, host } = capture;
  const source = exportEnvironmentName(capture, request.name);
  const { install, windowClass } = admitApplication(
    capture,
    source,
    request.packageUrl,
  );
  const electron = application.executable.electron_markers.length > 0;
  const { homePath, files, collisions, paths } = exportedStateFiles(
    capture,
    state,
  );
  const { text: dconf, ...dconfScrub } = seedDconf(
    state,
    context.seed,
    context.identity,
  );
  const seeds = new Map<string, SeedVersion>();
  const textSeeds: string[] = [];
  for (const [home, path] of files) {
    const version = versionAt(path, context.seed);
    if (!isWithinAny(home, paths) || version?.present !== true) continue;
    if (version.sha256 === null) continue;
    seeds.set(home, { sha256: version.sha256, format: version.format });
    if (isTextualFormat(version.format)) textSeeds.push(home);
  }
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
    electron,
    command: launchCommand(
      electronLaunchArguments(application.argv, electron),
      host.home,
      application.working_directory,
    ),
    windowClass,
    paths,
    capturedHome: host.home,
    seedCheckpoint: state.capture.checkpoints[context.seed] ?? "baseline",
    seedFiles: [...seeds.keys()].sort(),
    textSeeds: textSeeds.sort(),
    unseededFiles: unseededFiles(capture, homePath, files, {
      paths,
      seed: context.seed,
    }),
    dconf,
    captureEvidenceId: context.evidenceId,
  };
  const limitations = installLimitations(
    install,
    application.package,
    electron,
  );
  return { plan, seeds, limitations, collisions, files, dconf: dconfScrub };
};

const EXPORT_LIMITATIONS = [
  "The seed is the user's real state at the seed checkpoint; keep the bundle local.",
  "Binary state files are seeded as captured; only text files, UTF-8 or UTF-16 with a byte-order mark, have the capture host's name, user@host and home path replaced.",
];

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
  },
): string[] => {
  const opened = capture.state.unretained_opened_directories;
  return [
    ...EXPORT_LIMITATIONS,
    ...facts.install,
    ...(plan.unseededFiles.length === 0
      ? []
      : [
          `${String(plan.unseededFiles.length)} file(s) under the owned paths existed at the seed but were not retained, so they are not seeded.`,
        ]),
    ...(facts.identity.hostname === null || facts.identity.user === null
      ? [
          "The capture does not record the host's name and user, so only the captured home is removed from the seed; capture again to remove them too.",
        ]
      : []),
    ...(opened.length === 0
      ? []
      : [
          `The application held files open in ${opened.join(", ")}, whose starting content the capture did not retain, so nothing there is seeded.`,
        ]),
    ...facts.collisions.map(
      ({ home, kept, dropped }) =>
        `${dropped} and ${kept} both map to ~/${home}; the export uses ${kept} and leaves out ${dropped}.`,
    ),
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
  const { plan, seeds, collisions, files, dconf, ...install } = planExport(
    request,
    capture,
    state,
    { evidenceId: evidence.evidence_id, seed: ends.seed, identity },
  );
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
  let scrub: SeedScrubReport = { scrubbed: [], unscrubbed: [] };
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
        seed_checkpoint: request.seedCheckpoint ?? null,
        end_checkpoint: request.endCheckpoint ?? null,
      },
      result: {
        ...result,
        checkpoints: { ...result.checkpoints },
        paths: [...result.paths],
        seed_files: [...result.seed_files],
        unseeded_files: [...result.unseeded_files],
        scrubbed_files: [...result.scrubbed_files],
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
