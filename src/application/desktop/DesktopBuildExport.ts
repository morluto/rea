import { Readable } from "node:stream";

import { z } from "zod";

import { AnalysisError } from "../../domain/analysisErrorBase.js";
import { AnalysisCancelledError } from "../../domain/analysisErrorCore.js";
import type { desktopTaskSchema } from "../../domain/desktop/appTask.js";
import { counted } from "../../domain/desktop/appExportUnowned.js";
import {
  SIGN_IN_END,
  SIGN_IN_START,
  type BuildConsent,
} from "../../domain/desktop/appWithheld.js";
import {
  gzipInside,
  isUncheckedGzip,
  MAX_GUNZIPPED_BYTES,
  redactSecrets,
  redactSecretsInJson,
  secretsIn,
  type KnownSecret,
} from "../../domain/desktop/buildSecrets.js";
import { jsonValueSchema, type JsonValue } from "../../domain/jsonValue.js";
import { err, ok, type Result } from "../../domain/result.js";
import { AGENTENV_PROVIDER } from "../../desktop/AgentEnvComputerHelper.js";
import {
  fetchHomeFolder,
  type ControlledComputer,
} from "../../desktop/BuildComputerController.js";
import {
  adapterError,
  ENDS,
  errorText,
  readOutput,
  refused,
  reportedFailure,
  runRea,
} from "./DesktopBuildCommands.js";
import {
  writeOutputTree,
  writtenWithOpenHandles,
} from "./DesktopOutputTree.js";

const EXPORT = "export_build_environment";
const exportResultSchema = z.looseObject({
  environment: z.string(),
  seed_files: z.array(z.string()),
  scrubbed_files: z.array(z.string()),
  // An export from before gzip seeds were listed apart has none.
  recompressed_files: z.array(z.string()).default([]),
  unscrubbed_files: z.array(z.string()),
  limitations: z.array(z.string()),
  task: jsonValueSchema,
  // An export from before withheld files were listed has none.
  withheld_files: z
    .array(
      z.looseObject({
        file: z.string(),
        variable: z.string(),
        handle: z.string(),
      }),
    )
    .default([]),
  consented_files: z.array(z.string()).default([]),
});

/** What the agent asks the export for: its task, the folder here, optionally the environment's name, files to withhold, and whether to seed withheld state with the person's consent. */
export interface BuildExportRequest {
  readonly task: z.output<typeof desktopTaskSchema>;
  readonly directory: string;
  readonly name?: string | undefined;
  readonly withhold?: readonly string[] | undefined;
  readonly seed_sign_in?: boolean | undefined;
}

/** A withheld file as the export reports it: the variable a deploy reads and the handle of the secret file REA keeps its bytes in. */
type WithheldReport = {
  readonly file: string;
  readonly variable: string;
  readonly handle: string;
};

/** An exported bundle brought back to this host. */
export type ExportedBuild = {
  readonly directory: string;
  readonly environment: string;
  readonly files: number;
  readonly bytes: number;
  readonly task: JsonValue;
  readonly seed_files: string[];
  readonly scrubbed_files: string[];
  readonly recompressed_files: string[];
  readonly unscrubbed_files: string[];
  readonly limitations: string[];
  readonly withheld_files: WithheldReport[];
  readonly consented_files: string[];
};

/** Explicitly supplied secrets the bundle may not hold. */
interface BundleGuard {
  readonly secrets: readonly KnownSecret[];
}

/** Why a fetched file is held back: known secrets or an unchecked gzip. */
const heldBack = (
  file: { readonly path: string; readonly bytes: Buffer },
  guard: BundleGuard,
) => {
  // A gzip file is decompressed once for the secret checks.
  const inner = guard.secrets.length === 0 ? undefined : gzipInside(file.bytes);
  return {
    handles: [
      ...new Set([
        ...secretsIn(Buffer.from(file.path), guard.secrets),
        ...secretsIn(file.bytes, guard.secrets, inner),
      ]),
    ],
    unchecked: guard.secrets.length > 0 && isUncheckedGzip(file.bytes, inner),
  };
};

/** The refusal of gzip files too large for REA to check for known secrets. */
const uncheckedRefusal = (
  holding: readonly { readonly path: string }[],
  directory: string,
) =>
  refused(
    EXPORT,
    `REA could not check inside ${counted(holding.map(({ path }) => path))}: each is a gzip file that expands past ${String(MAX_GUNZIPPED_BYTES / 1024 / 1024)} MiB, the most REA decompresses to look for known secrets, so REA wrote none of the bundle to ${directory}.`,
    "Keep each such file out of the seed: delete it in the app before marking seed, or capture again on a new build computer without it, then export again.",
  );

/** The refusal of a bundle whose files hold secrets: each secret's handle and the files, the values in their names redacted. */
const secretsRefusal = (
  holding: readonly { readonly path: string; readonly handles: string[] }[],
  secrets: readonly KnownSecret[],
  directory: string,
) => {
  const handles = [...new Set(holding.flatMap(({ handles: found }) => found))];
  const found = secrets.filter(({ handle }) => handles.includes(handle));
  return refused(
    EXPORT,
    `The bundle holds the secret ${handles.join(", ")} in ${counted(holding.map(({ path }) => redactSecrets(path, found)))}, so REA wrote none of it to ${directory}: no bundle may hold a secret.`,
    "Keep the secret out of the seed: delete the file that holds it in the app before marking seed, or capture again on a new build computer without it, then export again.",
  );
};

/**
 * Bring the bundle back straight into the caller's new or empty folder, each
 * checked answer written before the next is fetched; a failure leaves no
 * partial folder.
 */
const writeBundle = async (
  computer: ControlledComputer,
  bundle: string,
  {
    directory,
    guard,
  }: { readonly directory: string; readonly guard: BundleGuard },
  signal: AbortSignal,
): Promise<
  Result<{ readonly files: number; readonly bytes: number }, AnalysisError>
> => {
  let fetched = { files: 0, bytes: 0 };
  const holding: {
    path: string;
    handles: string[];
    unchecked: boolean;
  }[] = [];
  const unclosed = await writeOutputTree(
    directory,
    async (tree) => {
      fetched = await fetchHomeFolder(
        computer,
        bundle,
        {
          file: async (file) => {
            // Keep back known secrets and files REA could not check.
            const held = heldBack(file, guard);
            if (held.handles.length > 0 || held.unchecked) {
              holding.push({ path: file.path, ...held });
              return;
            }
            await tree.write(
              file.path,
              Readable.from([file.bytes]),
              { bytes: file.bytes.length, sha256: file.sha256 },
              signal,
            );
          },
        },
        signal,
      );
      const secret = holding.filter(({ handles }) => handles.length > 0);
      if (secret.length > 0)
        throw secretsRefusal(secret, guard.secrets, directory);
      const unchecked = holding.filter((held) => held.unchecked);
      if (unchecked.length > 0) throw uncheckedRefusal(unchecked, directory);
    },
    { operation: EXPORT, field: "directory" },
    signal,
  );
  return unclosed === undefined
    ? ok(fetched)
    : err(
        writtenWithOpenHandles(
          { provider: AGENTENV_PROVIDER, operation: EXPORT, what: "bundle" },
          directory,
          unclosed,
        ),
      );
};

/** The export's arguments past the capture and the bundle: the task, the ends, the install, and withheld state with its consents. */
const exportArguments = (
  capture: {
    readonly packageUrl?: string;
    readonly extraPackages: readonly string[];
    readonly signIn: boolean;
    readonly consents: readonly BuildConsent[];
  },
  request: BuildExportRequest,
  files: {
    readonly task: string;
    readonly consent: string;
    readonly withheld: string;
  },
): string[] => [
  "--task",
  files.task,
  ...ENDS,
  // The building agent made the seed in this computer for the task.
  "--synthetic-seed",
  ...(request.name === undefined ? [] : ["--name", request.name]),
  ...(capture.packageUrl === undefined
    ? []
    : ["--package-url", capture.packageUrl]),
  ...capture.extraPackages.flatMap((name) => ["--extra-package", name]),
  ...(capture.signIn
    ? ["--withhold-from", SIGN_IN_START, "--withhold-to", SIGN_IN_END]
    : []),
  ...(request.withhold ?? []).flatMap((path) => ["--withhold-path", path]),
  ...(capture.consents.length === 0 ? [] : ["--consent", files.consent]),
  ...(request.seed_sign_in === true ? ["--seed-withheld"] : []),
  "--withheld-copy",
  files.withheld,
  "--json",
];

/** The consent records as `consent.json` holds them. */
const consentFile = (consents: readonly BuildConsent[]): string =>
  `${JSON.stringify({ consents }, null, 2)}\n`;

/** Keep each withheld file's bytes as a secret, fetched from beside the bundle, reported by the handle that keeps it; none leaves REA otherwise. */
const keepWithheld = async (
  computer: ControlledComputer,
  folder: string,
  files: readonly WithheldReport[],
  {
    keep,
    signal,
    completed,
  }: {
    readonly keep: (handle: string, bytes: Buffer) => Promise<string>;
    readonly signal: AbortSignal;
    readonly completed: WithheldReport[];
  },
): Promise<WithheldReport[]> => {
  if (files.length === 0) return [];
  const handles = new Map(files.map((entry) => [entry.file, entry]));
  const kept = new Map<string, string>();
  await fetchHomeFolder(
    computer,
    folder,
    {
      file: async ({ path, bytes }) => {
        const report = handles.get(path);
        if (report !== undefined) {
          const actual = await keep(report.handle, bytes);
          kept.set(path, actual);
          completed.push({ ...report, handle: actual });
        }
      },
    },
    signal,
  );
  if (kept.size !== handles.size)
    throw new Error("The exported bundle did not supply every withheld file.");
  return files.map(({ file, variable, handle }) => ({
    file,
    variable,
    handle: kept.get(file) ?? handle,
  }));
};

/** The stopped capture an export runs on, and what it holds back and records. */
interface ExportCapture {
  readonly folder: string;
  readonly attempt: number;
  /** The URL a computer downloads the app's `.deb` from, when the capture says apt does not install it. */
  readonly packageUrl?: string;
  /** The packages the request named beside the app, which the bundle installs beside it too. */
  readonly extraPackages: readonly string[];
  /** The secrets no bundle may hold, and where the withheld files' bytes are kept as secrets. */
  readonly secrets: readonly KnownSecret[];
  readonly keep: (handle: string, bytes: Buffer) => Promise<string>;
  /** Whether both sign-in checkpoints were marked, and the consents the person gave. */
  readonly signIn: boolean;
  readonly consents: readonly BuildConsent[];
}

/**
 * Export a stopped capture in the computer with the agent's task, seeded at
 * `seed` and checked at `end`, into a new folder of the work folder, then
 * bring the bundle back and write it into the caller's folder. A task the
 * export refuses is refused with the export's own reason.
 */
export const exportBuild = async (
  computer: ControlledComputer,
  capture: ExportCapture,
  request: BuildExportRequest,
  signal: AbortSignal,
): Promise<Result<ExportedBuild, AnalysisError>> => {
  const { folder } = capture;
  const attempt = String(capture.attempt);
  const bundle = `${folder}/bundle-${attempt}`;
  const task = `${folder}/task-${attempt}.json`;
  const consent = `${folder}/consent-${attempt}.json`;
  const withheld = `${bundle}-withheld`;
  const stdout = `${folder}/export-${attempt}.json`;
  const taskFile = `${JSON.stringify(request.task, null, 2)}\n`;
  const completed: WithheldReport[] = [];
  let published:
    | {
        readonly directory: string;
        readonly environment: string;
        readonly files: number;
        readonly bytes: number;
      }
    | undefined;
  try {
    const { stdoutBytes: bytes } = await runRea(
      computer,
      [
        "export-desktop-application",
        `${folder}/capture`,
        bundle,
        ...exportArguments(capture, request, { task, consent, withheld }),
      ],
      {
        stdout,
        files: {
          [task]: taskFile,
          ...(capture.consents.length === 0
            ? {}
            : { [consent]: consentFile(capture.consents) }),
        },
        signal,
      },
    );
    const output = await readOutput(computer, stdout, bytes, signal);
    if (output.kind === "failure")
      return err(
        output.failure.code === "invalid_request"
          ? refused(
              EXPORT,
              output.failure.message,
              output.failure.remediation?.action ??
                "Rewrite the task and export again.",
            )
          : reportedFailure(EXPORT, output),
      );
    const result = exportResultSchema.parse(output.result);
    const written = await writeBundle(
      computer,
      bundle,
      {
        directory: request.directory,
        guard: {
          secrets: capture.secrets,
        },
      },
      signal,
    );
    if (!written.ok) return written;
    published = {
      directory: request.directory,
      environment: result.environment,
      ...written.value,
    };
    const kept = await keepWithheld(computer, withheld, result.withheld_files, {
      keep: capture.keep,
      signal,
      completed,
    });
    return ok({
      directory: request.directory,
      environment: result.environment,
      files: written.value.files,
      bytes: written.value.bytes,
      task: result.task,
      seed_files: result.seed_files,
      scrubbed_files: result.scrubbed_files,
      recompressed_files: result.recompressed_files,
      unscrubbed_files: result.unscrubbed_files,
      limitations: result.limitations,
      withheld_files: kept,
      consented_files: result.consented_files,
    });
  } catch (cause: unknown) {
    const failure =
      cause instanceof AnalysisError
        ? cause
        : signal.aborted && cause === signal.reason
          ? new AnalysisCancelledError(EXPORT, { cause })
          : adapterError(
              EXPORT,
              redactSecrets(errorText(cause), capture.secrets),
              cause,
            );
    if (published !== undefined)
      failure.retainDiagnostics({
        published_bundle: redactSecretsInJson(
          { ...published, withheld_files: completed },
          capture.secrets,
        ),
      });
    return err(failure);
  }
};
