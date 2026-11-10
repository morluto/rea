import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { Readable } from "node:stream";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  consentFileSchema,
  MAX_WITHHELD_BYTES,
  namedWithheldPaths,
  SIGN_IN_END,
  SIGN_IN_START,
  withheldFiles,
  withheldSettings,
  type WithheldFile,
  type WithholdSelection,
} from "../../domain/desktop/appWithheld.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import {
  versionAt,
  type DesktopApplicationState,
  type DesktopStatePath,
} from "../../domain/desktop/desktopState.js";
import { isWithinAny } from "../../domain/desktop/desktopStateDiff.js";
import { safeParseUtf8Json } from "../../domain/safeJson.js";
import type { SeedVersion } from "./DesktopExportFiles.js";
import { writeOutputTree, type FailedRelease } from "./DesktopOutputTree.js";
import {
  withRetainedContent,
  type RetainedContent,
} from "./DesktopRetainedContent.js";

const OPERATION = "export_desktop_application";
/** Largest retained file read back, as the export reads seeds. */
const SEED_MAX_BYTES = 1024 * 1024 * 1024;
/** An empty file's digest: an empty withheld file holds nothing another can copy. */
const EMPTY_SHA256 = createHash("sha256").digest("hex");

const refused = (
  field: string,
  userMessage: string,
  remediationAction: string,
) =>
  new AnalysisInputError(
    OPERATION,
    { userMessage, remediationAction, conformsToInputContract: true },
    [{ path: [field], reason: "invalid_value", message: userMessage }],
  );

/** What the export asks of withheld state: which files, whether to seed them with the person's consent, and that consent's file. */
export interface WithheldRequest {
  readonly withhold?: WithholdSelection | undefined;
  readonly seedWithheld?: boolean | undefined;
  readonly consent?: string | undefined;
}

/** The seeds the bundle ships, the files withheld from them as settings, those seeded with consent instead, and the consent file it ships. */
export interface WithheldPlan {
  readonly seeds: ReadonlyMap<string, SeedVersion>;
  readonly textSeeds: readonly string[];
  readonly withheld: readonly WithheldFile[];
  readonly consented: readonly string[];
  readonly consent: string | undefined;
}

/** The consent file's records as the bundle ships them, refused unless it parses; undefined when none was given. */
const readConsent = async (path: string | undefined) => {
  if (path === undefined) return undefined;
  const bytes = await readFile(path).catch(() => undefined);
  const parsed = bytes === undefined ? undefined : safeParseUtf8Json(bytes);
  const consent =
    parsed?.ok === true ? consentFileSchema.safeParse(parsed.value) : undefined;
  if (consent?.success !== true)
    throw refused(
      "consent",
      `The consent file ${path} is not a consent record REA writes.`,
      "Pass the consent.json record_build_consent's records were written to.",
    );
  return consent.data;
};

/** Refuse a seed file whose bytes equal a withheld file's, as a backup or a copy under another name, naming both and never the bytes. */
const refuseWithheldCopies = (
  seeds: ReadonlyMap<string, SeedVersion>,
  left: ReadonlySet<string>,
) => {
  const withheld = new Map(
    [...left].flatMap((file) => {
      const digest = seeds.get(file)?.sha256;
      return digest === undefined || digest === EMPTY_SHA256
        ? []
        : [[digest, file] as const];
    }),
  );
  const copies = [...seeds].flatMap(([home, { sha256 }]) => {
    const original = withheld.get(sha256);
    return left.has(home) || original === undefined
      ? []
      : [`${home} (a copy of ${original})`];
  });
  if (copies.length > 0)
    throw refused(
      "withhold",
      `The seed holds withheld bytes under another name: ${copies.join(", ")}, so REA wrote no bundle.`,
      "Trash each copy in the app or the file manager before marking seed and capture again, or name it in withhold too, then export again.",
    );
};

/**
 * Decide what the seed withholds: files changed in the sign-in window and
 * those named, under the owned paths, each becoming a secret setting the
 * deploy takes from the environment, unless the person consented to seed
 * them. Refused for a window it cannot place, a seeded file too large for a
 * setting, or seeding them with no seed_sign_in consent.
 */
export const planWithheld = async (
  request: WithheldRequest,
  capture: DesktopApplicationCapture,
  state: {
    readonly app: string;
    readonly homePath: (path: string) => string | null;
    readonly paths: readonly string[];
    readonly seeds: ReadonlyMap<string, SeedVersion>;
    readonly textSeeds: readonly string[];
  },
): Promise<WithheldPlan> => {
  const files = withheldFiles(
    capture.state.checkpoints,
    state.homePath,
    state.paths,
    request.withhold ?? {},
  );
  if (!files.ok)
    throw refused(
      "withhold",
      `REA cannot withhold the sign-in state: ${files.error}.`,
      `Mark ${SIGN_IN_START} before signing in and ${SIGN_IN_END} after it, and name only files under the owned paths.`,
    );
  const seedFiles = [...state.seeds.keys()];
  const named = namedWithheldPaths(
    request.withhold?.paths ?? [],
    state.homePath,
    state.paths,
  );
  const unmatched = (named.ok ? named.value : []).filter(
    (path) => !seedFiles.some((file) => isWithinAny(file, [path])),
  );
  if (unmatched.length > 0)
    throw refused(
      "withhold",
      `${unmatched.join(", ")} names no file the seed holds, so REA cannot tell what to withhold.`,
      "Name each file, or the folder holding it, as the draft's files list them.",
    );
  const consent = await readConsent(request.consent);
  const seeded = seedFiles
    .filter((file) => isWithinAny(file, files.value))
    .sort();
  const shipped =
    consent === undefined ? undefined : `${JSON.stringify(consent, null, 2)}\n`;
  if (request.seedWithheld === true) {
    if (consent?.consents.some(({ kind }) => kind === "seed_sign_in") !== true)
      throw refused(
        "seed_withheld",
        "Seeding the withheld sign-in state needs the person's consent to it, and the consent file holds none.",
        "Ask the person whether the bundle may hold their signed-in state, record their answer with record_build_consent, kind seed_sign_in, and export again; or export without seeding it.",
      );
    return { ...state, withheld: [], consented: seeded, consent: shipped };
  }
  const left = new Set(seeded);
  refuseWithheldCopies(state.seeds, left);
  return {
    seeds: new Map([...state.seeds].filter(([home]) => !left.has(home))),
    textSeeds: state.textSeeds.filter((home) => !left.has(home)),
    withheld: withheldSettings(state.app, seeded),
    consented: [],
    consent: shipped,
  };
};

/** The app's dconf keys a version holds, as `<group>/<key>`, each with its value. */
const dconfKeys = (
  version: DesktopStatePath["versions"][number] | undefined,
): ReadonlyMap<string, string> => {
  const view = version?.present === true ? version.view : null;
  const groups =
    typeof view === "object" && view !== null && !Array.isArray(view)
      ? view.groups
      : undefined;
  if (typeof groups !== "object" || groups === null || Array.isArray(groups))
    return new Map();
  return new Map(
    Object.entries(groups).flatMap(([group, keys]) =>
      typeof keys === "object" && keys !== null && !Array.isArray(keys)
        ? Object.entries(keys).map(
            ([key, value]) =>
              [`${group}/${key}`, JSON.stringify(value)] as const,
          )
        : [],
    ),
  );
};

/** Refuse the app's dconf keys that the sign-in window changed and the seed holds other than before it, unless seeded with consent: the class ships dconf keys and cannot withhold them as it does files. */
export const refuseSignInDconf = (
  request: WithheldRequest,
  state: DesktopApplicationState,
  seed: number,
): void => {
  const { from, to } = request.withhold ?? {};
  if (from === undefined || to === undefined || request.seedWithheld === true)
    return;
  const database = state.paths.find(
    (path) => path.format === "dconf" && path.role === "application_state",
  );
  if (database === undefined) return;
  const at = (index: number) => dconfKeys(versionAt(database, index));
  const { checkpoints } = state.capture;
  const before = at(checkpoints.indexOf(from));
  const after = at(checkpoints.indexOf(to));
  const changed = [...at(seed)]
    .filter(
      ([key, value]) =>
        after.get(key) !== before.get(key) && value !== before.get(key),
    )
    .map(([key]) => key);
  if (changed.length > 0)
    throw refused(
      "withhold",
      `The app's dconf keys ${changed.join(", ")} changed between ${from} and ${to}, and the seed holds them, but REA withholds files, not dconf keys, so it wrote no bundle.`,
      "If the person consents to ship them, record it with record_build_consent, kind seed_sign_in, and export with seed_sign_in; otherwise capture again on a new build computer, signing out of the app before marking seed.",
    );
};

/** Each withheld file's bytes at the seed, refused when one is too large for a setting. */
const readWithheld = async (
  content: RetainedContent,
  withheld: readonly WithheldFile[],
  seeds: ReadonlyMap<string, SeedVersion>,
  signal: AbortSignal | undefined,
): Promise<ReadonlyMap<string, Buffer>> => {
  const bytes = new Map<string, Buffer>();
  for (const { file } of withheld) {
    const digest = seeds.get(file)?.sha256;
    const read =
      digest === undefined ? undefined : await content.read(digest, signal);
    if (read?.ok !== true)
      throw refused(
        "withhold",
        `The retained content of ~/${file} could not be read.`,
        "Capture again.",
      );
    if (read.value.length > MAX_WITHHELD_BYTES)
      throw refused(
        "withhold",
        `~/${file} holds ${String(read.value.length)} bytes, more than the ${String(MAX_WITHHELD_BYTES)} a setting can take back at run time.`,
        "Withhold only the file that holds the sign-in or licence, or seed it with the person's consent.",
      );
    bytes.set(file, read.value);
  }
  return bytes;
};

/** Write the withheld files, by home path, into a new or empty folder outside the bundle; a failed release of a written copy is returned. */
const writeWithheldCopy = (
  directory: string,
  files: ReadonlyMap<string, Buffer>,
  signal: AbortSignal | undefined,
): Promise<FailedRelease | undefined> =>
  writeOutputTree(
    directory,
    async (tree) => {
      for (const [file, bytes] of files)
        await tree.write(
          file,
          Readable.from([bytes]),
          {
            bytes: bytes.length,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          signal,
        );
    },
    { operation: OPERATION, field: "withheld_copy" },
    signal,
  );

/** A path with every link in its existing part resolved, so two spellings of one folder compare equal. */
const resolvedPath = async (path: string): Promise<string> => {
  const rest: string[] = [];
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      return join(await realpath(current), ...rest);
    } catch {
      if (dirname(current) === current) return resolve(path);
      rest.unshift(basename(current));
    }
  }
};

const isWithin = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** Refuse a copy folder that is the bundle's, inside it or holding it, also through a link, before either is written. */
const refuseCopyInBundle = async (copy: string, bundle: string) => {
  const [copied, bundled] = await Promise.all([
    resolvedPath(copy),
    resolvedPath(bundle),
  ]);
  if (isWithin(copied, bundled) || isWithin(bundled, copied))
    throw refused(
      "withheld_copy",
      `The withheld copy ${copy} lies in the bundle ${bundle}, or holds it, so the withheld files would ship with it.`,
      "Name a copy folder outside the bundle's folder.",
    );
};

/** The withheld files read before the bundle is written, so one too large refuses the export first, whether or not a copy is asked for, and a write of them into the request's copy folder after; nothing without one. */
export const withheldCopy = async (
  request: {
    readonly capture: string;
    readonly directory: string;
    readonly withheldCopy?: string | undefined;
  },
  plan: { readonly withheld?: readonly WithheldFile[] | undefined },
  captured: ReadonlyMap<string, SeedVersion>,
  signal: AbortSignal | undefined,
): Promise<{
  readonly write: () => Promise<FailedRelease | undefined>;
}> => {
  const directory = request.withheldCopy;
  const withheld = plan.withheld ?? [];
  if (directory !== undefined)
    await refuseCopyInBundle(directory, request.directory);
  if (withheld.length === 0) return { write: () => Promise.resolve(undefined) };
  const files = await withRetainedContent(
    request.capture,
    (content) => readWithheld(content, withheld, captured, signal),
    SEED_MAX_BYTES,
  );
  return {
    write: () =>
      directory === undefined
        ? Promise.resolve(undefined)
        : writeWithheldCopy(directory, files, signal),
  };
};
