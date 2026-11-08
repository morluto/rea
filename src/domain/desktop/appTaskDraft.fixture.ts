import type { JsonValue } from "../jsonValue.js";
import type { DesktopTaskCheckInput } from "./appTask.js";
import { evaluateTaskChecks } from "./appTaskChecks.js";
import { draftTaskFiles, type TaskDraftFile } from "./appTaskDraft.js";
import { leftOutFiles } from "./appExportUnowned.js";
import type { DesktopStatePath } from "./desktopState.js";
import { xmlView } from "./stateFormats.js";

type Format = DesktopStatePath["format"];
type Role = DesktopStatePath["role"];

/** A file's state at checkpoint 0 (the seed) and 1 (the end); a null view is a file absent there. */
export const statePath = (
  role: Role,
  format: Format,
  before: JsonValue | null,
  after: JsonValue | null,
): DesktopStatePath => ({
  path: "/home/ada/x",
  home_path: "x",
  role,
  reasons: [],
  format,
  versions: [before, after].map((view, index) => ({
    checkpoint_index: index,
    checkpoint: index === 0 ? "seed" : "end",
    present: view !== null,
    sha256: view === null ? null : String(index).repeat(64),
    format: view === null ? null : format,
    view,
    view_error: null,
  })),
  changes: [],
});

/** The draft of files by home path, every one served, from the seed to the end. */
export const draftOf = (
  files: Record<string, DesktopStatePath>,
  selected: readonly string[] = [],
): readonly TaskDraftFile[] =>
  draftTaskFiles(
    new Map(Object.entries(files)),
    () => true,
    {
      seed: 0,
      end: 1,
    },
    leftOutFiles(new Map(Object.entries(files)), [], selected, selected)
      .isLeftOut,
  );

/** An XML text's view, which a test's own text always has. */
export const xml = (text: string): JsonValue => {
  const view = xmlView(text);
  if (view === undefined) throw new Error(`not XML: ${text}`);
  return view;
};

/** The one drafted file of an XML file's two saves. */
export const xmlDraft = (
  before: string,
  after: string,
  {
    role = "document",
    file = "Documents/doc.xml",
  }: { role?: Role; file?: string } = {},
): TaskDraftFile => {
  const [drafted] = draftOf({
    [file]: statePath(role, "xml", xml(before), xml(after)),
  });
  if (drafted === undefined) throw new Error("the file did not change");
  return drafted;
};

/** Which checks pass on one XML view of a file, in order. */
export const passing = (
  file: string,
  view: JsonValue,
  checks: readonly DesktopTaskCheckInput[],
): boolean[] =>
  evaluateTaskChecks(
    checks.map((check, index) => ({ ...check, id: `c${String(index)}` })),
    new Map([[file, { format: "xml" as const, view }]]),
  ).map(({ passed }) => passed);

/** The pointer a check reads, when it reads one. */
export const pointerOf = (check: DesktopTaskCheckInput): string | undefined =>
  "pointer" in check ? check.pointer : undefined;
