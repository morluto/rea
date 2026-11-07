import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";

import { AnalysisInputError } from "../../domain/analysisErrorCore.js";
import {
  consentFileSchema,
  MAX_WITHHELD_BYTES,
  SIGN_IN_END,
  SIGN_IN_START,
  withheldFiles,
  withheldSettings,
  type WithheldFile,
  type WithholdSelection,
} from "../../domain/desktop/appWithheld.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import { safeParseUtf8Json } from "../../domain/safeJson.js";
import type { SeedVersion } from "./DesktopExportFiles.js";
import { writeOutputTree } from "./DesktopOutputTree.js";
import {
  withRetainedContent,
  type RetainedContent,
} from "./DesktopRetainedContent.js";

const OPERATION = "export_desktop_application";
/** Largest retained file read back, as the export reads seeds. */
const SEED_MAX_BYTES = 1024 * 1024 * 1024;

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
  const consent = await readConsent(request.consent);
  const seeded = files.value.filter((file) => state.seeds.has(file));
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
  return {
    seeds: new Map([...state.seeds].filter(([home]) => !left.has(home))),
    textSeeds: state.textSeeds.filter((home) => !left.has(home)),
    withheld: withheldSettings(state.app, seeded),
    consented: [],
    consent: shipped,
  };
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

/** Write the withheld files, by home path, into a new or empty folder outside the bundle. */
const writeWithheldCopy = async (
  directory: string,
  files: ReadonlyMap<string, Buffer>,
  signal: AbortSignal | undefined,
): Promise<void> => {
  await writeOutputTree(
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
};

/** The withheld files read before the bundle is written, so one too large refuses the export first, and a write of them into the request's copy folder after; nothing without one. */
export const withheldCopy = async (
  request: {
    readonly capture: string;
    readonly withheldCopy?: string | undefined;
  },
  plan: { readonly withheld?: readonly WithheldFile[] | undefined },
  captured: ReadonlyMap<string, SeedVersion>,
  signal: AbortSignal | undefined,
): Promise<{ readonly write: () => Promise<void> }> => {
  const directory = request.withheldCopy;
  const withheld = plan.withheld ?? [];
  if (directory === undefined || withheld.length === 0)
    return { write: () => Promise.resolve() };
  const files = await withRetainedContent(
    request.capture,
    (content) => readWithheld(content, withheld, captured, signal),
    SEED_MAX_BYTES,
  );
  return { write: () => writeWithheldCopy(directory, files, signal) };
};
