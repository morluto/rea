import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { preflightPropertyListDecode } from "../artifacts/apple/PropertyListDecodeBudget.js";
import { decodeBinaryPlistValue } from "../artifacts/apple/BinaryPlistMaterializer.js";
import { BinaryTargetError } from "../domain/configurationErrors.js";
import { isPathWithinRoot } from "../domain/localPath.js";
import { parseXmlPropertyList } from "../domain/propertyListKeys.js";
import { decodeXmlPlistText } from "../domain/propertyListXmlText.js";
import { hasBinaryPlistSignature } from "../domain/apple/appleArchiveFormat.js";
import { err, ok, type Result } from "../domain/result.js";
import { absoluteCallerPath } from "../filesystem/callerPath.js";

/** Decoded representation bound for one binary Info.plist. */
const BINARY_PLIST_DECODE_BYTES = 16 * 1024 * 1024;

/** Where one app bundle layout keeps its Info.plist and program file. */
interface BundleLayout {
  readonly plist: readonly string[];
  readonly programs: readonly string[];
  readonly programsLabel: string;
}

const BUNDLE_LAYOUTS: readonly BundleLayout[] = [
  // macOS bundles keep both under Contents.
  {
    plist: ["Contents", "Info.plist"],
    programs: ["Contents", "MacOS"],
    programsLabel: "Contents/MacOS",
  },
  // iOS-style bundles, as extracted from an IPA, keep both at the root.
  { plist: ["Info.plist"], programs: [], programsLabel: "the bundle root" },
];

/** A resolved bundle program file and the Info.plist that declared it. */
export interface ResolvedAppBundle {
  readonly executable: string;
  readonly infoPlist?: string;
}

/** Resource-only identity for an app directory; it is not a BinaryTarget. */
export interface ResolvedAppBundleResourceRoot {
  /** Path selected by the caller, retained even when it is a symlink alias. */
  readonly callerPath: string;
  /** Canonical directory whose resources are inspected. */
  readonly canonicalPath: string;
  readonly infoPlistPath: string;
  readonly layout: "contents" | "root";
  /** No executable was opened or hashed by resource-root discovery. */
  readonly executableSha256: string | null;
}

/** Filesystem operations used by the resolver, injectable for boundary tests. */
export interface AppBundleFileSystem {
  readonly readFile: (path: string) => Promise<Buffer>;
  readonly realpath: (path: string) => Promise<string>;
  readonly decodeBinaryPlist?: (path: string) => Promise<string>;
}

const defaultFileSystem: AppBundleFileSystem = { readFile, realpath };

/**
 * Resolve an app bundle directory to its declared program file. macOS and
 * flat iOS-style layouts are read directly. An iOS app installed on a Mac is
 * a wrapper whose `Wrapper` directory holds the iOS bundle; that bundle is
 * found by listing `Wrapper`, never by following the `WrappedBundle` link.
 */
export const resolveAppBundleExecutable = async (
  path: string,
  fileSystem: AppBundleFileSystem = defaultFileSystem,
): Promise<Result<ResolvedAppBundle, BinaryTargetError>> => {
  try {
    const layout = await presentLayout(path);
    if (layout !== undefined)
      return await resolveLayoutExecutable(path, layout, fileSystem);
    const wrapped = await wrappedBundle(path);
    if (wrapped !== undefined) {
      const wrappedLayout = await presentLayout(wrapped);
      if (wrappedLayout !== undefined)
        return await resolveLayoutExecutable(
          wrapped,
          wrappedLayout,
          fileSystem,
        );
    }
  } catch (cause: unknown) {
    if (cause instanceof BinaryTargetError) return err(cause);
    return err(
      new BinaryTargetError(path, errorReason(cause, path), { cause }),
    );
  }
  return err(
    new BinaryTargetError(
      path,
      `app Info.plist is missing or no supported bundle layout was found: ${path}`,
      {
        cause: new Error(
          "No Contents/Info.plist, root Info.plist, or single Wrapper/*.app bundle was found",
        ),
      },
    ),
  );
};

/**
 * Resolve only the root and Info.plist layout needed for read-only resource
 * inspection. This intentionally does not require or guess CFBundleExecutable.
 */
export const findAppBundleResourceRoot = async (
  path: string,
  options: { readonly cwd?: string } = {},
): Promise<
  Result<ResolvedAppBundleResourceRoot | undefined, BinaryTargetError>
> => {
  const callerPath = absoluteCallerPath(
    path,
    options.cwd === undefined ? {} : { cwd: options.cwd },
  );
  try {
    const canonicalInput = await realpath(callerPath);
    const directLayout = await presentLayout(canonicalInput);
    const wrapped =
      directLayout === undefined
        ? await wrappedBundle(canonicalInput)
        : undefined;
    const root = wrapped ?? canonicalInput;
    const layout = directLayout ?? (await presentLayout(root));
    if (layout === undefined) return ok(undefined);
    const canonicalPath = await realpath(root);
    return ok({
      callerPath,
      canonicalPath,
      infoPlistPath: join(canonicalPath, ...layout.plist),
      layout: layout.plist[0] === "Contents" ? "contents" : "root",
      executableSha256: null,
    });
  } catch (cause: unknown) {
    if (cause instanceof BinaryTargetError) return err(cause);
    return err(
      new BinaryTargetError(callerPath, errorReason(cause, callerPath), {
        cause,
      }),
    );
  }
};

/** Require a discovered bundle layout while preserving typed read failures. */
export const resolveAppBundleResourceRoot = async (
  path: string,
  options: { readonly cwd?: string } = {},
): Promise<Result<ResolvedAppBundleResourceRoot, BinaryTargetError>> => {
  const found = await findAppBundleResourceRoot(path, options);
  if (!found.ok) return found;
  if (found.value !== undefined) return ok(found.value);
  const callerPath = absoluteCallerPath(path, options);
  return err(
    new BinaryTargetError(
      callerPath,
      `app resource root has no supported Info.plist layout: ${callerPath}`,
    ),
  );
};

const presentLayout = async (
  bundle: string,
): Promise<BundleLayout | undefined> => {
  for (const layout of BUNDLE_LAYOUTS)
    if (await layoutPlistPresent(join(bundle, ...layout.plist))) return layout;
  return undefined;
};

/**
 * Whether a layout's Info.plist exists. Readable symlinks count, as they did
 * when the plist was read directly; any failure other than absence, such as
 * a permission denial, is left for the caller to report.
 */
const layoutPlistPresent = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isFile();
  } catch (cause: unknown) {
    if (isAbsence(cause)) return false;
    if (isPermissionDenied(cause))
      throw new BinaryTargetError(
        path,
        `permission denied inspecting app Info.plist ${path}`,
        { cause },
      );
    throw cause;
  }
};

const isAbsence = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR";
};

const errorCode = (cause: unknown): unknown =>
  cause instanceof Error ? Reflect.get(cause, "code") : undefined;

const codeDescription = (cause: unknown): string => {
  const code = errorCode(cause);
  return typeof code === "string" || typeof code === "number"
    ? ` (${String(code)})`
    : "";
};

const isSystemErrorCode = (cause: unknown): boolean => {
  const code = errorCode(cause);
  return (
    typeof code === "string" &&
    /^[A-Z][A-Z0-9_]+$/u.test(code) &&
    !code.startsWith("ERR_")
  );
};

const isPermissionDenied = (cause: unknown): boolean =>
  errorCode(cause) === "EACCES" || errorCode(cause) === "EPERM";

const errorReason = (cause: unknown, path: string): string =>
  isPermissionDenied(cause)
    ? `permission denied accessing app bundle path ${path}`
    : isAbsence(cause)
      ? `app bundle path is missing: ${path}`
      : `could not inspect app bundle path ${path}`;

/** The single real `.app` directory inside an iOS-on-Mac `Wrapper`. */
const wrappedBundle = async (bundle: string): Promise<string | undefined> => {
  const wrapper = join(bundle, "Wrapper");
  try {
    if (!(await lstat(wrapper)).isDirectory()) return undefined;
  } catch (cause: unknown) {
    if (isAbsence(cause)) return undefined;
    throw cause;
  }
  let app: string | undefined;
  for await (const entry of await opendir(wrapper)) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith(".app"))
      continue;
    if (app !== undefined) return undefined;
    app = join(wrapper, entry.name);
  }
  return app;
};

const resolveLayoutExecutable = async (
  bundle: string,
  layout: BundleLayout,
  fileSystem: AppBundleFileSystem,
): Promise<Result<ResolvedAppBundle, BinaryTargetError>> => {
  const plistPath = join(bundle, ...layout.plist);
  let plist: Buffer;
  try {
    plist = await fileSystem.readFile(plistPath);
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(
        plistPath,
        isPermissionDenied(cause)
          ? `permission denied reading app Info.plist ${plistPath}`
          : isAbsence(cause)
            ? `app Info.plist is missing: ${plistPath}`
            : `could not read app Info.plist ${plistPath}${codeDescription(cause)}`,
        { cause },
      ),
    );
  }

  let name: string;
  try {
    name = hasBinaryPlistSignature(plist)
      ? await (fileSystem.decodeBinaryPlist?.(plistPath) ??
          parseBinaryPlistExecutable(plist))
      : parseXmlPlistExecutable(decodeXmlPlistText(plist));
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(
        plistPath,
        isPermissionDenied(cause)
          ? `permission denied decoding app Info.plist ${plistPath}${codeDescription(cause)}`
          : isSystemErrorCode(cause)
            ? `could not decode app Info.plist ${plistPath}${codeDescription(cause)}`
            : `app Info.plist is malformed, unsupported, or lacks CFBundleExecutable: ${plistPath}${cause instanceof Error ? ` (${cause.message})` : ""}`,
        { cause },
      ),
    );
  }
  if (!isSafeExecutableName(name))
    return err(
      new BinaryTargetError(bundle, "app has an unsafe CFBundleExecutable"),
    );
  const programs = join(bundle, ...layout.programs);
  const executable = join(programs, name);
  let canonicalBundle: string;
  try {
    canonicalBundle = await fileSystem.realpath(bundle);
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(bundle, errorReason(cause, bundle), { cause }),
    );
  }
  try {
    const canonicalPrograms = await fileSystem.realpath(programs);
    if (!isPathWithinRoot(canonicalBundle, canonicalPrograms))
      return err(
        new BinaryTargetError(
          bundle,
          `app program directory leaves ${layout.programsLabel}`,
        ),
      );
    const canonicalExecutable = await fileSystem.realpath(executable);
    if (!isPathWithinRoot(canonicalPrograms, canonicalExecutable))
      return err(
        new BinaryTargetError(
          bundle,
          `app program file leaves ${layout.programsLabel}`,
        ),
      );
    return ok({ executable: canonicalExecutable, infoPlist: plistPath });
  } catch (cause: unknown) {
    return err(
      new BinaryTargetError(
        executable,
        isPermissionDenied(cause)
          ? `permission denied resolving app program file ${executable}`
          : isAbsence(cause)
            ? `app program file is missing: ${executable}`
            : `could not resolve app program file ${executable}`,
        { cause },
      ),
    );
  }
};

/** Decode the top-level executable name with an XML parser, not a pattern. */
const parseXmlPlistExecutable = (plist: string): string => {
  // An unrelated `__proto__` entry must not make the bundle unreadable.
  const { value } = parseXmlPropertyList(plist);
  return executableName(value);
};

const executableName = (value: unknown): string => {
  const executable = executableEntrySchema.safeParse(value);
  if (!executable.success) throw new Error("CFBundleExecutable is missing");
  return executable.data.CFBundleExecutable;
};

const executableEntrySchema = z.looseObject({ CFBundleExecutable: z.string() });

/** Decode a binary plist in-process, so no host plist tool is required. */
const parseBinaryPlistExecutable = (plist: Buffer): string => {
  const plan = preflightPropertyListDecode(plist, BINARY_PLIST_DECODE_BYTES);
  return executableName(decodeBinaryPlistValue(plist, plan));
};

const isSafeExecutableName = (name: string): boolean =>
  name.length > 0 &&
  name !== "." &&
  name !== ".." &&
  !name.includes("\0") &&
  !/[/\\]/u.test(name);
