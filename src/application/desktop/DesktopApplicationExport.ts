import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable } from "node:stream";

import { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import { outputDirectoryAdmissionRefusal } from "../../artifacts/SafeOutputTreeAdmission.js";
import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  DESKTOP_EXPORT_FRAMEWORK_VERSION,
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
import type { JsonValue } from "../../domain/jsonValue.js";
import { isPortableBundleName } from "../environment/environmentBundle.js";
import {
  inspectDesktopApplicationState,
  readDesktopCapture,
  readRetainedContent,
  type DesktopStateReaders,
} from "./DesktopApplicationState.js";
import { desktopOperationFailure } from "./DesktopCaptureRefusals.js";

const OPERATION = "export_desktop_application";

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

/** The application's dconf groups at the baseline, as `dconf load /` input. */
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

/** Decide the bundle from the capture and its state view, refusing what v1 cannot install. */
const planExport = (
  request: DesktopExportRequest,
  capture: DesktopApplicationCapture,
  state: DesktopApplicationState,
  evidenceId: string,
): DesktopAppExportPlan => {
  const { application, session, host } = capture;
  const { package: installed } = application;
  if (
    installed.kind !== "deb" ||
    installed.name === null ||
    installed.sources.length === 0
  )
    throw refuse(
      `The application is not installed from a Debian package archive (${installed.kind}${installed.name === null ? "" : ` ${installed.name}`}), so the computer cannot install it.`,
      "capture",
      "Capture an application installed with apt from the distribution archive.",
    );
  const window = session.window_match;
  if (window === null)
    throw refuse(
      "The capture saw no application window, so the export cannot match the app's window to tell when it is ready.",
      "capture",
      "Capture again and wait for the application window to open.",
    );
  const source =
    request.name ??
    environmentName(
      application.desktop_entry?.id ??
        application.executable.path.split("/").at(-1) ??
        "app",
    );
  if (!isPortableBundleName(source))
    throw refuse(
      `${source} is not a portable environment name.`,
      "name",
      "Pass --name with lowercase letters, digits and hyphens.",
    );
  const home = host.home;
  const relative = (path: string) =>
    path.startsWith(`${home}/`) ? path.slice(home.length + 1) : null;
  const stateDirectories = application.state_directories
    .map((entry) => relative(entry.path))
    .filter((path): path is string => path !== null);
  const homePaths = (role: string) =>
    state.paths
      .filter(
        (path) =>
          path.role === role &&
          path.format !== "dconf" &&
          path.home_path !== null,
      )
      .map((path) => path.home_path ?? "");
  const paths = ownedPaths(
    homePaths("application_state"),
    homePaths("document"),
    stateDirectories,
  );
  const seedFiles = state.paths
    .filter(
      (path) =>
        path.home_path !== null &&
        path.format !== "dconf" &&
        isWithinAny(path.home_path, paths) &&
        path.versions[0]?.present === true &&
        path.versions[0].sha256 !== null,
    )
    .map((path) => path.home_path ?? "");
  return {
    name: source,
    className: className(source),
    title: application.desktop_entry?.name ?? source,
    aptPackage: installed.name.split(":")[0] ?? installed.name,
    packageVersion: installed.version,
    command: launchCommand(application.argv, home),
    windowClass: window.class,
    paths,
    capturedHome: home,
    seedFiles,
    dconf: baselineDconf(state).text,
    captureEvidenceId: evidenceId,
  };
};

const EXPORT_LIMITATIONS = [
  "The seed is the user's real state before the capture; keep the bundle local.",
  "The application is installed from the distribution archive by name, so the computer may install a different version than the one captured.",
  "Binary state files are seeded as captured; only text files have the captured home path respelled.",
];

const writeBundle = async (
  directory: string,
  files: readonly { readonly path: string; readonly bytes: Buffer }[],
  signal: AbortSignal | undefined,
): Promise<void> => {
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  let tree: SafeOutputTree | undefined;
  try {
    tree = await SafeOutputTree.create(directory, process.platform, {
      acceptExistingEmpty: true,
    });
    for (const file of files) {
      signal?.throwIfAborted();
      await tree.write(file.path, Readable.from([file.bytes]), {
        bytes: file.bytes.length,
        sha256: createHash("sha256").update(file.bytes).digest("hex"),
      });
    }
    await tree.commit(signal);
  } catch (cause: unknown) {
    throw outputDirectoryAdmissionRefusal(OPERATION, "directory", cause);
  } finally {
    await tree?.closeHandles();
  }
};

const runExport = async (
  request: DesktopExportRequest,
  readers: DesktopStateReaders,
  signal: AbortSignal | undefined,
): Promise<DesktopExportResult> => {
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
  const plan = planExport(request, capture, state, evidence.evidence_id);
  const environment = `envs/${plan.name}`;
  const text = (path: string, content: string) => ({
    path,
    bytes: Buffer.from(content),
  });
  const files: { readonly path: string; readonly bytes: Buffer }[] = [
    text("README.md", renderReadme(plan)),
    text(`${environment}/env.toml`, renderEnvToml(plan)),
    text(`${environment}/${plan.name}.py`, renderAppClass(plan)),
    text(`${environment}/SKILL.md`, renderSkill(plan)),
    text("tasks/smoke.json", renderSmokeTask(plan)),
  ];
  for (const seed of plan.seedFiles) {
    const version = state.paths.find((path) => path.home_path === seed)
      ?.versions[0];
    const bytes =
      version?.sha256 === null || version?.sha256 === undefined
        ? undefined
        : await readRetainedContent(request.capture, version.sha256, signal);
    if (bytes === undefined)
      throw refuse(
        `The retained content of ~/${seed} is missing or does not match its digest.`,
        "capture",
        "Capture the application again.",
      );
    files.push({ path: `${environment}/seed/${seed}`, bytes });
  }
  await writeBundle(request.directory, files, signal);
  return {
    directory: request.directory,
    environment: plan.name,
    framework_version: DESKTOP_EXPORT_FRAMEWORK_VERSION,
    paths: plan.paths,
    seed_files: plan.seedFiles,
    dconf_groups: baselineDconf(state).groups,
    files: files.map((file) => file.path),
    limitations: EXPORT_LIMITATIONS,
  };
};

/** Export one capture folder as an agentenv computer app bundle. */
export const exportDesktopApplication = async (
  request: DesktopExportRequest,
  readers: DesktopStateReaders,
  signal?: AbortSignal,
): Promise<DesktopExportResult | AnalysisError> => {
  try {
    return await runExport(request, readers, signal);
  } catch (cause: unknown) {
    return desktopOperationFailure(cause, signal, OPERATION, "Desktop export");
  }
};
