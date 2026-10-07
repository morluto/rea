import { join } from "node:path";
import {
  createAnalysisExecution,
  type ExecutionOptions,
} from "../../application/AnalysisProvider.js";
import type { SafeOutputTree } from "../../artifacts/SafeOutputTree.js";
import {
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../../domain/analysisErrorCore.js";
import type { JavaScriptRecoveryInput } from "../../domain/javascriptRecovery.js";
import { jsonValueSchema } from "../../domain/jsonValue.js";
import {
  fingerprintRecoveryFile,
  inventoryRecoveryFiles,
  readRecoveryFile,
  recoveryDigest,
  type snapshotRecoveryInput,
} from "./RecoveryFiles.js";
import {
  runWakaruCommand,
  type resolveWakaruCommand,
  type WakaruLauncher,
} from "./WakaruCommand.js";
import { parseWakaruReports } from "./WakaruReport.js";
import { publishWakaruArtifacts } from "./WakaruPublication.js";
import { RECOVERY_LIMITS, WAKARU_RELEASE } from "./WakaruRelease.js";

const OPERATION = "recover_javascript_sources";
const MODES = {
  structural: "strict",
  heuristic: "auto",
  inspection: "inspect",
} as const;

type RecoveryWorkspace = {
  root: string;
  tree: SafeOutputTree;
  input: JavaScriptRecoveryInput;
  source: Awaited<ReturnType<typeof snapshotRecoveryInput>>;
  engine: Awaited<ReturnType<typeof resolveWakaruCommand>>;
  environment: Readonly<Record<string, string | undefined>>;
  launcher: WakaruLauncher | undefined;
  options: ExecutionOptions | undefined;
  deadline: number;
};

/** Consume the pinned producer representation in a private workspace. */
const executeWakaruRecovery = async (context: RecoveryWorkspace) => {
  const { root, input, source, engine, environment, launcher, options } =
    context;
  const staging = join(root, "modules");
  const commandContext = {
    ...engine,
    cwd: root,
    deadline: context.deadline,
    environment: environment,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
    ...(launcher === undefined ? {} : { launcher: launcher }),
  };
  const version = await runWakaruCommand({
    ...commandContext,
    arguments: ["--version"],
  });
  if (
    version.exit_code !== 0 ||
    version.stdout.trim() !== `wakaru ${WAKARU_RELEASE.version}`
  )
    throw new AnalysisCapabilityUnavailableError(
      "wakaru",
      OPERATION,
      `This adapter requires Wakaru ${WAKARU_RELEASE.version}; reported version: ${version.stdout.trim()}; exit: ${String(version.exit_code)}; stderr: ${version.stderr}`,
    );
  const run = await runWakaruCommand({
    ...commandContext,
    staging,
    arguments: [
      source.snapshot_path,
      `--unpack=${MODES[input.extraction_mode]}`,
      `--level=${input.rewrite_level}`,
      "--provenance",
      "--emit-source-map",
      "--json",
      "-o",
      staging,
    ],
  });
  const files = await inventoryRecoveryFiles(staging, options?.signal);
  const snapshot = await readRecoveryFile(
    source.snapshot_path,
    RECOVERY_LIMITS.inputBytes,
    options?.signal,
  );
  const parsed = await parseWakaruReports({
    execution: run,
    provenancePath: join(staging, "provenance.json"),
    snapshotPath: source.snapshot_path,
    sourceBytes: snapshot,
    files,
  });
  return { version, run, parsed };
};

/** Publish validated recovery and retain exact source and engine bindings. */
export const prepareWakaruExecution = async (context: RecoveryWorkspace) => {
  const { root, tree, input, source, engine, options } = context;
  const staging = join(root, "modules");
  const { version, run, parsed } = await executeWakaruRecovery(context);
  const result = await publishWakaruArtifacts({
    tree,
    staging,
    input,
    source,
    engine,
    parsed,
    execution: run,
    ...(options?.signal === undefined ? {} : { signal: options.signal }),
  });
  if (
    recoveryDigest(
      await readRecoveryFile(
        input.path,
        RECOVERY_LIMITS.inputBytes,
        options?.signal,
      ),
    ) !== source.sha256
  )
    throw new AnalysisOutputError(
      OPERATION,
      `Original input changed during recovery: ${input.path}`,
    );
  if (
    (
      await fingerprintRecoveryFile(
        engine.command,
        RECOVERY_LIMITS.outputBytes,
        options?.signal,
      )
    ).sha256 !== engine.sha256
  )
    throw new AnalysisOutputError(
      OPERATION,
      "Configured engine bytes changed during recovery",
    );
  return createAnalysisExecution(
    result,
    { id: "wakaru", name: "Wakaru", version: WAKARU_RELEASE.version },
    {
      rawResult: jsonValueSchema.parse({
        version,
        execution: run,
        report: parsed.report,
        provenance: parsed.provenance,
      }),
      subject: {
        path: source.path,
        sha256: source.sha256,
        format: "javascript",
      },
      locations: [
        { kind: "artifact-path", path: source.path },
        ...result.modules.map((module) => ({
          kind: "artifact-path" as const,
          path: module.artifact.path,
        })),
      ],
      limitations: result.limitations,
    },
  );
};
