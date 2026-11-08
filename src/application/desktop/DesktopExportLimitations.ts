import type {
  DesktopAppExportPlan,
  HomePathCollision,
} from "../../domain/desktop/appExport.js";
import { launchDocumentLimitation } from "../../domain/desktop/appExport.js";
import {
  heldOpenLimitation,
  leftOutLocksLimitation,
  leftOutLogsLimitation,
  runtimeSeedsLimitation,
  unownedFoldersLimitation,
} from "../../domain/desktop/appExportUnowned.js";
import type { DesktopApplicationCapture } from "../../domain/desktop/desktopCapture.js";
import type { HostIdentity } from "../../domain/desktop/hostIdentity.js";
import { recoveryListLimitation } from "../../domain/desktop/seedRecoveryList.js";

/** The limitation naming files the desktop Trash held at the seed; none when it held none. */
export const trashedFilesLimitation = (
  files: readonly string[],
): string | undefined =>
  files.length === 0
    ? undefined
    : `The desktop Trash held ${String(files.length)} file(s) at the seed checkpoint, which are not seeded: ${files.map((home) => `~/${home}`).join(", ")}. Restore one the task needs and capture again.`;

/** The limitation on where the seed came from: made for the task, or the user's real state, kept local. */
export const seedLimitation = (syntheticSeed: boolean): string =>
  syntheticSeed
    ? "The seed was made for the task, not taken from a user's own data; read it before publishing the bundle."
    : "The seed is the user's real state at the seed checkpoint; keep the bundle local.";

const SCRUB_LIMITATION =
  "Binary state files are seeded as captured; only text files, UTF-8 or UTF-16 with a byte-order mark, and gzip documents, scrubbed inside, have the capture host's name, user@host and home path replaced. A gzip document so rewritten is compressed again as one member with no extra field, so a BGZF or dictzip file loses the blocks its index names.";

/** What the export says the bundle leaves out or cannot promise, in the order a reader needs it. */
export const exportLimitations = (
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
  const trashed = trashedFilesLimitation(facts.trashed);
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
    ...(trashed === undefined ? [] : [trashed]),
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
