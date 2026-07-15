import canonicalize from "canonicalize";

import { enhancedInputSchemas } from "../contracts/enhancedInputs.js";
import { parseEvidence, type Evidence } from "./evidence.js";
import { functionDossierSchema, type FunctionDossier } from "./hopperValues.js";

const MAX_PAGES = 100;
const MAX_ITEMS = 50_000;
const MAX_PSEUDOCODE_CHARS = 2_000_000;

const DOSSIER_COLLECTION_FIELDS = [
  "assembly",
  "comments",
  "callers",
  "callees",
  "incoming_references",
  "outgoing_references",
  "referenced_strings",
  "referenced_names",
  "basic_blocks",
] as const;

type DossierCollectionField = (typeof DOSSIER_COLLECTION_FIELDS)[number];
type DossierItem<Field extends DossierCollectionField> =
  FunctionDossier[Field]["items"][number];

export interface FunctionCollection<Item = unknown> {
  readonly items: readonly Item[];
  readonly total: number | null;
  readonly complete: boolean;
  readonly truncated: boolean;
}

type FunctionCollections = {
  readonly [Field in DossierCollectionField]: FunctionCollection<
    DossierItem<Field>
  >;
};

/** Verified, bounded function observation assembled from Evidence pages. */
export interface FunctionSnapshot {
  readonly evidence: readonly Evidence[];
  readonly procedure: FunctionDossier["procedure"];
  readonly provider: Evidence["provider"];
  readonly subject: NonNullable<Evidence["subject"]>;
  readonly pseudocode: {
    readonly text: string;
    readonly total: number;
    readonly complete: boolean;
    readonly truncated: boolean;
  };
  readonly collections: FunctionCollections;
  readonly instructionScan: FunctionDossier["instruction_scan"];
  readonly limitations: readonly string[];
}

interface DossierPage {
  readonly evidence: Omit<Evidence, "subject"> & {
    readonly subject: NonNullable<Evidence["subject"]>;
  };
  readonly dossier: FunctionDossier;
  readonly parameters: ReturnType<
    typeof enhancedInputSchemas.analyze_function.parse
  >;
}

/** Parse and assemble up to 100 mutually consistent analyze_function pages. */
export const parseFunctionEvidence = (input: unknown): FunctionSnapshot => {
  const values = Array.isArray(input) ? input : [input];
  if (values.length === 0 || values.length > MAX_PAGES)
    throw new TypeError("Function comparison requires 1 to 100 Evidence pages");
  const pages = values.map(parsePage);
  assertPageGroup(pages);
  const first = pages[0];
  if (first === undefined)
    throw new TypeError("Function comparison requires Evidence pages");
  const pseudocode = mergePseudocode(pages);
  const collections: FunctionCollections = {
    assembly: mergeCollection(pages, "assembly"),
    comments: mergeCollection(pages, "comments"),
    callers: mergeCollection(pages, "callers"),
    callees: mergeCollection(pages, "callees"),
    incoming_references: mergeCollection(pages, "incoming_references"),
    outgoing_references: mergeCollection(pages, "outgoing_references"),
    referenced_strings: mergeCollection(pages, "referenced_strings"),
    referenced_names: mergeCollection(pages, "referenced_names"),
    basic_blocks: mergeCollection(pages, "basic_blocks"),
  };
  return {
    evidence: pages.map(({ evidence }) => evidence),
    procedure: first.dossier.procedure,
    provider: first.evidence.provider,
    subject: first.evidence.subject,
    pseudocode,
    collections,
    instructionScan: first.dossier.instruction_scan,
    limitations: [
      ...new Set(
        pages.flatMap(({ evidence, dossier }) => [
          ...evidence.limitations,
          ...dossier.limitations,
        ]),
      ),
    ].sort((left, right) => left.localeCompare(right)),
  };
};

const parsePage = (input: unknown): DossierPage => {
  const evidence = parseEvidence(input);
  if (evidence.operation !== "analyze_function")
    throw new TypeError(
      "Function comparison requires analyze_function Evidence",
    );
  if (evidence.subject === null)
    throw new TypeError("Function comparison requires artifact-bound Evidence");
  return {
    evidence: { ...evidence, subject: evidence.subject },
    dossier: functionDossierSchema.parse(evidence.normalized_result),
    parameters: enhancedInputSchemas.analyze_function.parse(
      evidence.parameters,
    ),
  };
};

const assertPageGroup = (pages: readonly DossierPage[]): void => {
  const first = pages[0];
  if (first === undefined) return;
  const invariant = pageInvariant(first);
  for (const page of pages)
    if (canonicalJson(pageInvariant(page)) !== canonicalJson(invariant))
      throw new TypeError(
        "Function Evidence pages mix subjects, providers, or immutable analysis controls",
      );
};

const pageInvariant = (page: DossierPage) => ({
  subject: {
    digest: page.evidence.subject?.digest,
    format: page.evidence.subject?.format,
    architecture: page.evidence.subject?.architecture,
  },
  provider: page.evidence.provider,
  procedure: page.dossier.procedure,
  requested_procedure: page.parameters.procedure,
  include_assembly: page.parameters.include_assembly,
  max_instructions: page.parameters.max_instructions,
  instruction_scan: page.dossier.instruction_scan,
});

const mergePseudocode = (
  pages: readonly DossierPage[],
): FunctionSnapshot["pseudocode"] => {
  const totals = new Set(
    pages.map(({ dossier }) => dossier.pseudocode.total_chars),
  );
  if (totals.size !== 1)
    throw new TypeError("Function pseudocode pages disagree on total length");
  const total = pages[0]?.dossier.pseudocode.total_chars ?? 0;
  if (total > MAX_PSEUDOCODE_CHARS)
    throw new TypeError("Function pseudocode exceeds comparison limit");
  const characters = new Map<number, string>();
  for (const page of pages) {
    const offset = page.parameters.pseudocode_offset;
    for (const [index, character] of [
      ...page.dossier.pseudocode.text,
    ].entries())
      mergeIndexed(characters, offset + index, character, "pseudocode");
    if (characters.size > MAX_PSEUDOCODE_CHARS)
      throw new TypeError("Function pseudocode exceeds comparison limit");
  }
  const complete = hasCompleteRange(characters, total);
  return {
    text: orderedValues(characters).join(""),
    total,
    complete,
    truncated: !complete,
  };
};

const mergeCollection = <Field extends DossierCollectionField>(
  pages: readonly DossierPage[],
  field: Field,
): FunctionCollection<DossierItem<Field>> => {
  const totals = new Set(pages.map(({ dossier }) => dossier[field].total));
  if (totals.size !== 1)
    throw new TypeError(`Function ${field} pages disagree on total count`);
  const total = pages[0]?.dossier[field].total ?? null;
  if (total !== null && total > MAX_ITEMS)
    throw new TypeError(`Function ${field} exceeds comparison item limit`);
  const items = new Map<number, DossierItem<Field>>();
  for (const page of pages) {
    const offset = collectionOffset(page, field);
    for (const [index, item] of page.dossier[field].items.entries())
      mergeIndexed(items, offset + index, item, field);
    if (items.size > MAX_ITEMS)
      throw new TypeError(`Function ${field} exceeds comparison item limit`);
  }
  const scanLimited =
    field !== "assembly" && pageDependsOnScan(field)
      ? pages.some(({ dossier }) => dossier.instruction_scan.truncated)
      : false;
  const unavailable =
    field === "assembly" &&
    pages.every(({ parameters }) => !parameters.include_assembly);
  const complete =
    !scanLimited &&
    !unavailable &&
    total !== null &&
    hasCompleteRange(items, total);
  return {
    items: orderedValues(items),
    total,
    complete,
    truncated: scanLimited || (!unavailable && !complete),
  };
};

const collectionOffset = (
  page: DossierPage,
  field: DossierCollectionField,
): number =>
  field === "assembly"
    ? page.parameters.assembly_offset
    : page.parameters.collection_offset[field];

const pageDependsOnScan = (field: DossierCollectionField): boolean =>
  field !== "callers" && field !== "callees";

const mergeIndexed = <Value>(
  output: Map<number, Value>,
  index: number,
  value: Value,
  field: string,
): void => {
  const previous = output.get(index);
  if (
    previous !== undefined &&
    canonicalJson(previous) !== canonicalJson(value)
  )
    throw new TypeError(
      `Function ${field} pages overlap with conflicting data`,
    );
  output.set(index, value);
};

const hasCompleteRange = <Value>(
  values: ReadonlyMap<number, Value>,
  total: number,
): boolean => {
  if (values.size !== total) return false;
  for (let index = 0; index < total; index += 1)
    if (!values.has(index)) return false;
  return true;
};

const orderedValues = <Value>(values: ReadonlyMap<number, Value>): Value[] =>
  [...values.entries()]
    .sort(([left], [right]) => left - right)
    .map(([, value]) => value);

const canonicalJson = (value: unknown): string => {
  const encoded = canonicalize(value);
  if (encoded === undefined)
    throw new TypeError("Function Evidence could not be canonicalized");
  return encoded;
};
