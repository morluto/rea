import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { cp, lstat, mkdir, open, readdir, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import { AnalysisCancelledError } from "../domain/analysisErrorCore.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import type {
  AnalysisProjectSelection,
  BinaryTarget,
} from "../domain/binaryTargetTypes.js";
import { err, ok, type Result } from "../domain/result.js";

export interface AnalysisProjectTargetInput {
  readonly markerPath: string;
  readonly storagePath: string;
  readonly projectName: string;
  readonly documentPath: string;
  readonly signal?: AbortSignal;
}

/** Resolve a local project plus its backing storage as one immutable identity. */
export const parseAnalysisProjectTarget = async (
  input: AnalysisProjectTargetInput,
): Promise<
  Result<BinaryTarget, BinaryTargetError | AnalysisCancelledError>
> => {
  try {
    throwIfCancelled(input.signal);
    if (!isAbsolute(input.markerPath) || !isAbsolute(input.storagePath))
      throw new BinaryTargetError(
        input.markerPath,
        "analysis project paths must be absolute",
      );
    const projectName = validateProjectName(
      input.projectName,
      input.markerPath,
    );
    const expectedMarker = `${projectName}.gpr`;
    const observedMarker = basename(input.markerPath);
    if (
      process.platform === "win32"
        ? observedMarker.toLowerCase() !== expectedMarker.toLowerCase()
        : observedMarker !== expectedMarker
    )
      throw new BinaryTargetError(
        input.markerPath,
        `analysis project marker must be named ${expectedMarker}`,
      );
    const documentPath = normalizeDocumentPath(
      input.documentPath,
      input.markerPath,
    );
    const markerPath = await canonicalRegularFile(input.markerPath);
    const storagePath = await canonicalDirectory(input.storagePath);
    throwIfCancelled(input.signal);
    const sha256 = await digestAnalysisProject(
      markerPath,
      storagePath,
      input.signal,
    );
    return ok({
      path: markerPath,
      sourcePath: input.markerPath,
      sha256,
      kind: "database",
      format: "analysis-database",
      analysisProject: {
        markerPath,
        storagePath,
        projectName,
        documentPath,
      },
    });
  } catch (cause: unknown) {
    if (cause instanceof AnalysisCancelledError) return err(cause);
    if (cause instanceof BinaryTargetError) return err(cause);
    return err(
      new BinaryTargetError(
        input.markerPath,
        cause instanceof Error ? cause.message : String(cause),
        cause instanceof Error ? { cause } : undefined,
      ),
    );
  }
};

/** Digest both the project marker and every regular backing-store file. */
export const digestAnalysisProject = async (
  markerPath: string,
  storagePath: string,
  signal?: AbortSignal,
): Promise<string> => {
  const entries = [
    { absolute: markerPath, relative: "project.gpr" },
    ...(await listProjectFiles(storagePath, signal)).map((absolute) => ({
      absolute,
      relative: `project.rep/${relative(storagePath, absolute).split(sep).join("/")}`,
    })),
  ].sort((left, right) => left.relative.localeCompare(right.relative));
  const digest = createHash("sha256");
  digest.update("rea-analysis-project-v1\0");
  for (const entry of entries) {
    throwIfCancelled(signal);
    const name = Buffer.from(entry.relative, "utf8");
    const nameLength = Buffer.alloc(4);
    nameLength.writeUInt32BE(name.length);
    digest.update(nameLength);
    digest.update(name);
    const handle = await open(entry.absolute, constants.O_RDONLY);
    try {
      const metadata = await handle.stat();
      if (!metadata.isFile())
        throw new Error(
          `analysis project member is not a regular file: ${entry.absolute}`,
        );
      const size = Buffer.alloc(8);
      size.writeBigUInt64BE(BigInt(metadata.size));
      digest.update(size);
      for await (const chunk of handle.createReadStream()) {
        throwIfCancelled(signal);
        digest.update(chunk as Buffer);
      }
    } finally {
      await handle.close();
    }
  }
  return digest.digest("hex");
};

/** Copy an admitted project into an absent private directory and reverify it. */
export const copyAnalysisProject = async (
  selection: AnalysisProjectSelection,
  destinationRoot: string,
  expectedSha256: string,
  signal?: AbortSignal,
): Promise<AnalysisProjectSelection> => {
  throwIfCancelled(signal);
  await mkdir(destinationRoot, { recursive: true });
  const markerPath = join(destinationRoot, `${selection.projectName}.gpr`);
  const storagePath = join(destinationRoot, `${selection.projectName}.rep`);
  await cp(selection.markerPath, markerPath, {
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  await cp(selection.storagePath, storagePath, {
    recursive: true,
    errorOnExist: true,
    force: false,
    verbatimSymlinks: true,
  });
  throwIfCancelled(signal);
  const observed = await digestAnalysisProject(markerPath, storagePath, signal);
  if (observed !== expectedSha256)
    throw new BinaryTargetError(
      selection.markerPath,
      `analysis project changed while being copied: expected ${expectedSha256}, observed ${observed}`,
    );
  return { ...selection, markerPath, storagePath };
};

const listProjectFiles = async (
  root: string,
  signal?: AbortSignal,
): Promise<string[]> => {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    throwIfCancelled(signal);
    const directory = pending.pop()!;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink())
        throw new Error(
          `analysis project cannot contain symbolic links: ${path}`,
        );
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile()) files.push(path);
      else
        throw new Error(
          `analysis project contains an unsupported member: ${path}`,
        );
    }
  }
  return files;
};

const canonicalRegularFile = async (path: string): Promise<string> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isFile())
    throw new Error(`analysis project marker is not a regular file: ${path}`);
  return realpath(path);
};

const canonicalDirectory = async (path: string): Promise<string> => {
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory())
    throw new Error(`analysis project storage is not a directory: ${path}`);
  return realpath(path);
};

const validateProjectName = (value: string, path: string): string => {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    /[\\/\0\r\n]/u.test(value)
  )
    throw new BinaryTargetError(path, "analysis project name is invalid");
  return value;
};

const normalizeDocumentPath = (value: string, path: string): string => {
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized
    .split("/")
    .filter((segment) => segment.length > 0);
  if (
    segments.length === 0 ||
    segments.some(
      (segment) =>
        segment === "." || segment === ".." || /[*?\0\r\n]/u.test(segment),
    )
  )
    throw new BinaryTargetError(
      path,
      "analysis project document path is invalid",
    );
  return `/${segments.join("/")}`;
};

const throwIfCancelled = (signal?: AbortSignal): void => {
  if (signal?.aborted === true)
    throw new AnalysisCancelledError("resolve_binary_target");
};
