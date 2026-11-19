import { z } from "zod";

import { canonicalJson } from "../comparisonSemantics.js";
import { digestCanonicalValue } from "../canonicalDigest.js";
import { uniqueSorted } from "../canonicalOrdering.js";
import { compareUnicodeCodePoints } from "../unicodeCodePointOrder.js";
import { canonicalJsonDigestSteps } from "../canonicalJsonDigestSteps.js";
import {
  freezeOwnedJsonSnapshotSteps,
  freezeOwnedJsonTreeSnapshot,
} from "../immutableJson.js";
import {
  arrayContainerSchema,
  parseElementSteps,
} from "../zodCollectionSteps.js";
import { isRecord } from "../../kernel/isRecord.js";
import type {
  ApplicationGraphEvidence,
  ApplicationGraphEvidenceContext,
} from "./javascriptApplicationEvidenceSchemas.js";
import {
  applicationGraphEvidenceLocationSchema,
  applicationGraphEvidenceSchema,
  isCompatibleApplicationGraphEvidenceLocation,
  isValidApplicationGraphEvidenceContext,
  qualifyJavaScriptLoaderEvidence,
} from "./javascriptApplicationEvidenceSchemas.js";
import {
  JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
  JAVASCRIPT_SEMANTIC_RELATION_FAMILY,
  javaScriptSemanticFingerprintInputSchema,
  javaScriptSemanticFingerprintSchema,
  javaScriptSemanticEvidenceContextSchema,
  javaScriptSemanticGraphInputSchema,
  javaScriptSemanticGraphRecordSchema,
  javaScriptSemanticNodeInputSchema,
  javaScriptSemanticNodeSchema,
  javaScriptSemanticRelationInputSchema,
  javaScriptSemanticRelationSchema,
  javaScriptSemanticUnknownInputSchema,
  javaScriptSemanticUnknownSchema,
  type JavaScriptSemanticGraphInput,
  type JavaScriptSemanticGraphNode,
  type JavaScriptSemanticGraphRelation,
  type JavaScriptSemanticGraphUnknown,
  type JavaScriptSemanticFingerprint,
  type JavaScriptSemanticEvidenceContext,
  type JavaScriptSemanticEvidenceReference,
} from "./javascriptSemanticGraphSchemas.js";
import { prefixedDigestSchema } from "../digests.js";

const normalizeEvidence = (
  evidence: ApplicationGraphEvidence,
): ApplicationGraphEvidence => ({
  ...evidence,
  coverage:
    evidence.coverage.limits.length <= 1
      ? {
          ...evidence.coverage,
          limits: [...evidence.coverage.limits],
        }
      : {
          ...evidence.coverage,
          limits: [...evidence.coverage.limits].sort((left, right) =>
            compareUnicodeCodePoints(
              canonicalJson(left, "JavaScript semantic graph"),
              canonicalJson(right, "JavaScript semantic graph"),
            ),
          ),
        },
  limitations:
    evidence.limitations.length <= 1
      ? [...evidence.limitations]
      : uniqueSorted(evidence.limitations),
  evidence_ids:
    evidence.evidence_ids.length <= 1
      ? [...evidence.evidence_ids]
      : uniqueSorted(evidence.evidence_ids),
});

const evidenceContextId = (context: ApplicationGraphEvidenceContext): string =>
  `jsrg_evidence_${digestCanonicalValue(context, "JavaScript semantic evidence context")}`;

interface FrozenInternedEvidenceEntry {
  readonly authority: ApplicationGraphEvidence["authority"];
  readonly state: ApplicationGraphEvidence["state"];
  readonly confidence: ApplicationGraphEvidence["confidence"];
  readonly artifact: ApplicationGraphEvidence["artifact"];
  readonly extractor: ApplicationGraphEvidence["extractor"];
  readonly coverage: ApplicationGraphEvidence["coverage"];
  readonly limitations: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly contextId: string;
}

const hasReusableFrozenContext = (
  evidence: ApplicationGraphEvidence,
): boolean =>
  Object.isFrozen(evidence.artifact) &&
  Object.isFrozen(evidence.extractor) &&
  Object.isFrozen(evidence.coverage) &&
  Object.isFrozen(evidence.coverage.limits) &&
  evidence.coverage.limits.length === 0 &&
  Object.isFrozen(evidence.limitations) &&
  evidence.limitations.every((item) => typeof item === "string") &&
  Object.isFrozen(evidence.evidence_ids) &&
  evidence.evidence_ids.length === 0;

const EVIDENCE_INPUT_KEYS = [
  "authority",
  "state",
  "confidence",
  "artifact",
  "location",
  "extractor",
  "coverage",
  "limitations",
  "evidence_ids",
] as const;

const hasExactEvidenceKeys = (
  value: unknown,
): value is Record<(typeof EVIDENCE_INPUT_KEYS)[number], unknown> =>
  isRecord(value) &&
  Object.keys(value).length === EVIDENCE_INPUT_KEYS.length &&
  EVIDENCE_INPUT_KEYS.every((key) => Object.hasOwn(value, key));

const tryInternValidatedInputSymbol = Symbol("tryInternValidatedInput");
const internValidatedEvidenceSymbol = Symbol("internValidatedEvidence");

/** Graph-scoped owner for canonical provenance shared by semantic facts. */
export class JavaScriptSemanticEvidenceContextRegistry {
  readonly #contexts = new Map<string, JavaScriptSemanticEvidenceContext>();
  // Facts share a few contexts, so key them by canonical text and hash each
  // distinct context once instead of on every fact.
  readonly #idsByCanonicalContext = new Map<string, string>();
  readonly #frozenEntries: FrozenInternedEvidenceEntry[] = [];
  sourceLoaderCondition:
    | {
        readonly path: string;
        readonly sha256: string;
        readonly limitation: string;
      }
    | undefined;

  /** Fast-path interning when shared context objects match an already-validated frozen entry. */
  [tryInternValidatedInputSymbol](
    rawEvidence: unknown,
  ): JavaScriptSemanticEvidenceReference | undefined {
    if (
      this.sourceLoaderCondition !== undefined ||
      !hasExactEvidenceKeys(rawEvidence)
    )
      return undefined;
    const match = this.#frozenEntries.find(
      (entry) =>
        entry.authority === rawEvidence.authority &&
        entry.state === rawEvidence.state &&
        entry.confidence === rawEvidence.confidence &&
        entry.artifact === rawEvidence.artifact &&
        entry.extractor === rawEvidence.extractor &&
        entry.coverage === rawEvidence.coverage &&
        entry.limitations === rawEvidence.limitations &&
        entry.evidenceIds === rawEvidence.evidence_ids,
    );
    if (match === undefined) return undefined;
    const parsedLocation = applicationGraphEvidenceLocationSchema.safeParse(
      rawEvidence.location,
    );
    if (
      !parsedLocation.success ||
      !isCompatibleApplicationGraphEvidenceLocation(match, parsedLocation.data)
    )
      return undefined;
    return { context_id: match.contextId, location: parsedLocation.data };
  }

  /** Validate and intern non-location provenance at fact construction. */
  intern(
    evidence: ApplicationGraphEvidence,
  ): JavaScriptSemanticEvidenceReference {
    const fast = this[tryInternValidatedInputSymbol](evidence);
    if (fast !== undefined) return fast;
    const parsed = applicationGraphEvidenceSchema.parse(evidence);
    return this[internValidatedEvidenceSymbol](parsed, evidence);
  }

  /** Intern provenance that has already passed applicationGraphEvidenceSchema. */
  [internValidatedEvidenceSymbol](
    evidence: ApplicationGraphEvidence,
    originalInput?: ApplicationGraphEvidence,
  ): JavaScriptSemanticEvidenceReference {
    const fast = this[tryInternValidatedInputSymbol](originalInput ?? evidence);
    if (fast !== undefined) return fast;
    const condition = this.sourceLoaderCondition;
    const locationValue = evidence.location.available
      ? evidence.location.value
      : undefined;
    const normalized = normalizeEvidence(
      condition !== undefined &&
        evidence.artifact.available &&
        evidence.artifact.sha256 === condition.sha256 &&
        (locationValue?.kind === "source-range"
          ? locationValue.source
          : locationValue?.kind === "artifact-path"
            ? locationValue.path
            : undefined) === condition.path
        ? qualifyJavaScriptLoaderEvidence(evidence, condition.limitation)
        : evidence,
    );
    const { location, ...context } = normalized;
    const canonicalContext = canonicalJson(
      context,
      "JavaScript semantic graph",
    );
    let contextId = this.#idsByCanonicalContext.get(canonicalContext);
    if (contextId === undefined) {
      contextId = evidenceContextId(context);
      // This canonical context is new, so a row already stored under its
      // digest holds different provenance.
      if (this.#contexts.has(contextId))
        throw new TypeError(
          "JavaScript semantic evidence context digest collision",
        );
      const parsedContext = javaScriptSemanticEvidenceContextSchema.parse({
        ...context,
        context_id: contextId,
      });
      this.#contexts.set(contextId, sealSemanticEvidenceContext(parsedContext));
      this.#idsByCanonicalContext.set(canonicalContext, contextId);
    }
    const candidate =
      condition === undefined ? (originalInput ?? evidence) : normalized;
    if (
      this.#frozenEntries.length < 16 &&
      hasReusableFrozenContext(candidate) &&
      !this.#frozenEntries.some(
        (entry) =>
          entry.authority === candidate.authority &&
          entry.state === candidate.state &&
          entry.confidence === candidate.confidence &&
          entry.artifact === candidate.artifact &&
          entry.extractor === candidate.extractor &&
          entry.coverage === candidate.coverage &&
          entry.limitations === candidate.limitations &&
          entry.evidenceIds === candidate.evidence_ids,
      )
    ) {
      this.#frozenEntries.push({
        authority: candidate.authority,
        state: candidate.state,
        confidence: candidate.confidence,
        artifact: candidate.artifact,
        extractor: candidate.extractor,
        coverage: candidate.coverage,
        limitations: candidate.limitations,
        evidenceIds: candidate.evidence_ids,
        contextId,
      });
    }
    return { context_id: contextId, location };
  }

  /** Resolve one already interned fact reference for derived evidence. */
  resolve(
    reference: JavaScriptSemanticEvidenceReference,
  ): ApplicationGraphEvidence {
    const context = this.#contexts.get(reference.context_id);
    if (context === undefined)
      throw new TypeError(
        "Semantic evidence reference names an absent context",
      );
    const { context_id: _contextId, ...evidenceContext } = context;
    return { ...evidenceContext, location: reference.location };
  }

  /** Return caller-owned copies of this registry's context table. */
  get contexts(): JavaScriptSemanticEvidenceContext[] {
    return [...this.#contexts.values()]
      .sort((left, right) =>
        compareUnicodeCodePoints(left.context_id, right.context_id),
      )
      .map((context) => structuredClone(context));
  }

  /** Return sealed contexts for an exclusively owned graph builder. */
  get ownedContexts(): JavaScriptSemanticEvidenceContext[] {
    return [...this.#contexts.values()].sort((left, right) =>
      compareUnicodeCodePoints(left.context_id, right.context_id),
    );
  }

  /** Release interned contexts after the owning graph is finalized. */
  clear(): void {
    this.#contexts.clear();
    this.#idsByCanonicalContext.clear();
    this.#frozenEntries.length = 0;
  }

  /** Validate and intern provenance decoded in this realm from an analysis worker. */
  adopt(input: unknown): void {
    const context = validatedSemanticEvidenceContexts.has(input as object)
      ? (input as JavaScriptSemanticEvidenceContext)
      : freezeOwnedJsonTreeSnapshot(
          javaScriptSemanticEvidenceContextSchema.parse(input),
        );
    if (!validatedSemanticEvidenceContexts.has(context)) {
      const { context_id: identifier, ...value } = context;
      if (identifier !== evidenceContextId(value))
        throw new TypeError(
          "Transferred semantic evidence context identifier is stale",
        );
      validatedSemanticEvidenceContexts.add(context);
    }
    const { context_id: identifier, ...value } = context;
    const canonical = canonicalJson(
      value,
      "JavaScript semantic evidence context",
    );
    const existing = this.#contexts.get(identifier);
    if (existing !== undefined) {
      const { context_id: _existingIdentifier, ...existingValue } = existing;
      if (
        canonical !==
        canonicalJson(existingValue, "JavaScript semantic evidence context")
      )
        throw new TypeError(
          "Transferred semantic evidence context digest collision",
        );
    }
    this.#contexts.set(identifier, context);
    this.#idsByCanonicalContext.set(canonical, identifier);
  }
}

const validatedSemanticEvidenceContexts = new WeakSet<object>();
const validatedSemanticNodes = new WeakSet<object>();
const validatedSemanticRelations = new WeakSet<object>();
const validatedSemanticUnknowns = new WeakSet<object>();
const validatedSemanticFingerprints = new WeakSet<object>();

const isValidatedSemanticNode = (
  value: unknown,
): value is JavaScriptSemanticGraphNode =>
  typeof value === "object" &&
  value !== null &&
  validatedSemanticNodes.has(value);
const isValidatedSemanticRelation = (
  value: unknown,
): value is JavaScriptSemanticGraphRelation =>
  typeof value === "object" &&
  value !== null &&
  validatedSemanticRelations.has(value);
const isValidatedSemanticUnknown = (
  value: unknown,
): value is JavaScriptSemanticGraphUnknown =>
  typeof value === "object" &&
  value !== null &&
  validatedSemanticUnknowns.has(value);
const isValidatedSemanticFingerprint = (
  value: unknown,
): value is JavaScriptSemanticFingerprint =>
  typeof value === "object" &&
  value !== null &&
  validatedSemanticFingerprints.has(value);
const isValidatedSemanticEvidenceContext = (
  value: unknown,
): value is JavaScriptSemanticEvidenceContext =>
  typeof value === "object" &&
  value !== null &&
  validatedSemanticEvidenceContexts.has(value);

const sealSemanticEvidenceContext = (
  context: JavaScriptSemanticEvidenceContext,
): JavaScriptSemanticEvidenceContext => {
  const sealed = freezeOwnedJsonTreeSnapshot(context);
  validatedSemanticEvidenceContexts.add(sealed);
  return sealed;
};

const freezeEvidenceLocation = (
  location: JavaScriptSemanticEvidenceReference["location"],
): JavaScriptSemanticEvidenceReference["location"] => {
  if (location.available) {
    if (location.value.kind === "source-range") {
      Object.freeze(location.value.start);
      Object.freeze(location.value.end);
    }
    Object.freeze(location.value);
  }
  return Object.freeze(location);
};

const freezeEvidenceReference = (
  evidence: JavaScriptSemanticEvidenceReference,
): JavaScriptSemanticEvidenceReference => {
  freezeEvidenceLocation(evidence.location);
  return Object.freeze(evidence);
};

const freezeProperties = (
  properties: JavaScriptSemanticGraphNode["properties"],
): JavaScriptSemanticGraphNode["properties"] => {
  const keys = Object.keys(properties);
  if (keys.length === 0) return Object.freeze(properties);
  if (
    keys.every((key) => {
      const item = properties[key];
      return item === null || typeof item !== "object";
    })
  )
    return Object.freeze(properties);
  return freezeOwnedJsonTreeSnapshot(properties);
};

const sealSemanticNode = (
  node: JavaScriptSemanticGraphNode,
): JavaScriptSemanticGraphNode => {
  if (node.identity.source_range !== null) {
    Object.freeze(node.identity.source_range.start);
    Object.freeze(node.identity.source_range.end);
    Object.freeze(node.identity.source_range);
  }
  Object.freeze(node.identity);
  Object.freeze(node.application_node_ids);
  freezeProperties(node.properties);
  freezeEvidenceReference(node.evidence);
  const sealed = Object.freeze(node);
  validatedSemanticNodes.add(sealed);
  return sealed;
};
const sealSemanticRelation = (
  relation: JavaScriptSemanticGraphRelation,
): JavaScriptSemanticGraphRelation => {
  freezeProperties(relation.properties);
  freezeEvidenceReference(relation.evidence);
  const sealed = Object.freeze(relation);
  validatedSemanticRelations.add(sealed);
  return sealed;
};
const sealSemanticUnknown = (
  unknown: JavaScriptSemanticGraphUnknown,
): JavaScriptSemanticGraphUnknown => {
  Object.freeze(unknown.relation_kinds);
  Object.freeze(unknown.candidate_node_ids);
  freezeEvidenceReference(unknown.evidence);
  const sealed = Object.freeze(unknown);
  validatedSemanticUnknowns.add(sealed);
  return sealed;
};
const sealSemanticFingerprint = (
  fingerprint: JavaScriptSemanticFingerprint,
): JavaScriptSemanticFingerprint => {
  Object.freeze(fingerprint.components.effects);
  Object.freeze(fingerprint.components);
  Object.freeze(fingerprint.limitations);
  freezeEvidenceReference(fingerprint.evidence);
  const sealed = Object.freeze(fingerprint);
  validatedSemanticFingerprints.add(sealed);
  return sealed;
};

const nodeInputWithoutEvidenceSchema = javaScriptSemanticNodeInputSchema.omit({
  evidence: true,
});
const relationInputWithoutEvidenceSchema =
  javaScriptSemanticRelationInputSchema.omit({ evidence: true });
const unknownInputWithoutEvidenceSchema =
  javaScriptSemanticUnknownInputSchema.omit({ evidence: true });
const fingerprintInputWithoutEvidenceSchema =
  javaScriptSemanticFingerprintInputSchema.omit({ evidence: true });
const applicationNodeIdsSchema = z.array(prefixedDigestSchema("jag_node"));

/** Derive a semantic node ID from its kind and exact artifact identity. */
export const javaScriptSemanticNodeId = (
  node: Pick<JavaScriptSemanticGraphNode, "kind" | "identity">,
): string =>
  `jsrg_node_${digestCanonicalValue({ kind: node.kind, identity: node.identity }, "JavaScript semantic graph")}`;

const buildSemanticGraphNode = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphNode => {
  if (isRecord(input) && Object.hasOwn(input, "evidence")) {
    const fastEvidence = evidenceContexts[tryInternValidatedInputSymbol](
      input.evidence,
    );
    if (fastEvidence !== undefined) {
      const { evidence: _evidence, ...rest } = input;
      const parsedRest = nodeInputWithoutEvidenceSchema.safeParse(rest);
      if (parsedRest.success) {
        const semantic = {
          ...parsedRest.data,
          application_node_ids:
            parsedRest.data.application_node_ids.length <= 1
              ? parsedRest.data.application_node_ids
              : uniqueSorted(parsedRest.data.application_node_ids),
          evidence: fastEvidence,
        };
        return {
          ...semantic,
          node_id: javaScriptSemanticNodeId(semantic),
        };
      }
    }
  }
  const rawEvidence = isRecord(input)
    ? (input.evidence as ApplicationGraphEvidence | undefined)
    : undefined;
  const parsed = javaScriptSemanticNodeInputSchema.parse(input);
  const semantic = {
    ...parsed,
    application_node_ids: uniqueSorted(parsed.application_node_ids),
    evidence: evidenceContexts[internValidatedEvidenceSymbol](
      parsed.evidence,
      rawEvidence,
    ),
  };
  return {
    ...semantic,
    node_id: javaScriptSemanticNodeId(semantic),
  };
};

/** Normalize one semantic entity and derive its artifact-version identifier. */
export const createJavaScriptSemanticGraphNode = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphNode =>
  buildSemanticGraphNode(input, evidenceContexts);

/** Normalize and seal one exclusively owned semantic entity. */
export const createOwnedJavaScriptSemanticGraphNode = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphNode =>
  sealSemanticNode(buildSemanticGraphNode(input, evidenceContexts));

/** Bind validated application-node identifiers while preserving node sealing. */
export const withJavaScriptSemanticNodeApplicationIds = (
  node: JavaScriptSemanticGraphNode,
  applicationNodeIds: readonly string[],
): JavaScriptSemanticGraphNode => {
  const normalized =
    applicationNodeIds.length === 0
      ? []
      : uniqueSorted(applicationNodeIdsSchema.parse(applicationNodeIds));
  if (
    validatedSemanticNodes.has(node) &&
    normalized.length === node.application_node_ids.length &&
    normalized.every((id, index) => id === node.application_node_ids[index])
  )
    return node;
  if (!validatedSemanticNodes.has(node)) {
    const parsed = javaScriptSemanticNodeSchema.parse({
      ...node,
      application_node_ids: normalized,
    });
    if (parsed.node_id !== javaScriptSemanticNodeId(parsed))
      throw new z.ZodError([
        {
          code: "custom",
          path: ["node_id"],
          message: "Node identifier is stale",
        },
      ]);
    return sealSemanticNode(parsed);
  }
  return sealSemanticNode({
    ...node,
    application_node_ids: normalized,
  });
};

const buildSemanticGraphRelation = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphRelation => {
  if (isRecord(input) && Object.hasOwn(input, "evidence")) {
    const fastEvidence = evidenceContexts[tryInternValidatedInputSymbol](
      input.evidence,
    );
    if (fastEvidence !== undefined) {
      const { evidence: _evidence, ...rest } = input;
      const parsedRest = relationInputWithoutEvidenceSchema.safeParse(rest);
      if (parsedRest.success) {
        const semantic = {
          ...parsedRest.data,
          evidence: fastEvidence,
        };
        return {
          ...semantic,
          relation_id: `jsrg_relation_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
        };
      }
    }
  }
  const rawEvidence = isRecord(input)
    ? (input.evidence as ApplicationGraphEvidence | undefined)
    : undefined;
  const parsed = javaScriptSemanticRelationInputSchema.parse(input);
  const semantic = {
    ...parsed,
    evidence: evidenceContexts[internValidatedEvidenceSymbol](
      parsed.evidence,
      rawEvidence,
    ),
  };
  return {
    ...semantic,
    relation_id: `jsrg_relation_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
  };
};

/** Normalize one semantic relationship and derive its exact identifier. */
export const createJavaScriptSemanticGraphRelation = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphRelation =>
  buildSemanticGraphRelation(input, evidenceContexts);

/** Normalize and seal one exclusively owned semantic relationship. */
export const createOwnedJavaScriptSemanticGraphRelation = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphRelation =>
  sealSemanticRelation(buildSemanticGraphRelation(input, evidenceContexts));

const buildSemanticGraphUnknown = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphUnknown => {
  if (isRecord(input) && Object.hasOwn(input, "evidence")) {
    const fastEvidence = evidenceContexts[tryInternValidatedInputSymbol](
      input.evidence,
    );
    if (fastEvidence !== undefined) {
      const { evidence: _evidence, ...rest } = input;
      const parsedRest = unknownInputWithoutEvidenceSchema.safeParse(rest);
      if (parsedRest.success) {
        const semantic = {
          ...parsedRest.data,
          relation_kinds: uniqueSorted(parsedRest.data.relation_kinds),
          candidate_node_ids: uniqueSorted(parsedRest.data.candidate_node_ids),
          evidence: fastEvidence,
        };
        return {
          ...semantic,
          unknown_id: `jsrg_unknown_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
        };
      }
    }
  }
  const rawEvidence = isRecord(input)
    ? (input.evidence as ApplicationGraphEvidence | undefined)
    : undefined;
  const parsed = javaScriptSemanticUnknownInputSchema.parse(input);
  const semantic = {
    ...parsed,
    relation_kinds: uniqueSorted(parsed.relation_kinds),
    candidate_node_ids: uniqueSorted(parsed.candidate_node_ids),
    evidence: evidenceContexts[internValidatedEvidenceSymbol](
      parsed.evidence,
      rawEvidence,
    ),
  };
  return {
    ...semantic,
    unknown_id: `jsrg_unknown_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
  };
};

/** Normalize one unresolved semantic frontier and derive its identifier. */
export const createJavaScriptSemanticGraphUnknown = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphUnknown =>
  buildSemanticGraphUnknown(input, evidenceContexts);

/** Normalize and seal one exclusively owned unresolved semantic frontier. */
export const createOwnedJavaScriptSemanticGraphUnknown = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticGraphUnknown =>
  sealSemanticUnknown(buildSemanticGraphUnknown(input, evidenceContexts));

const buildSemanticFingerprint = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticFingerprint => {
  if (isRecord(input) && Object.hasOwn(input, "evidence")) {
    const fastEvidence = evidenceContexts[tryInternValidatedInputSymbol](
      input.evidence,
    );
    if (fastEvidence !== undefined) {
      const { evidence: _evidence, ...rest } = input;
      const parsedRest = fingerprintInputWithoutEvidenceSchema.safeParse(rest);
      if (parsedRest.success) {
        const semantic = {
          ...parsedRest.data,
          components: {
            ...parsedRest.data.components,
            effects:
              parsedRest.data.components.effects.length <= 1
                ? parsedRest.data.components.effects
                : uniqueSorted(parsedRest.data.components.effects),
          },
          limitations:
            parsedRest.data.limitations.length <= 1
              ? parsedRest.data.limitations
              : uniqueSorted(parsedRest.data.limitations),
          evidence: fastEvidence,
        };
        const fingerprintSha256 = digestCanonicalValue(
          semantic.components,
          "JavaScript semantic graph",
        );
        return {
          ...semantic,
          fingerprint_sha256: fingerprintSha256,
          fingerprint_id: `jsrg_fingerprint_${digestCanonicalValue(
            {
              function_node_id: semantic.function_node_id,
              algorithm: semantic.algorithm,
              fingerprint_sha256: fingerprintSha256,
            },
            "JavaScript semantic graph",
          )}`,
        };
      }
    }
  }
  const rawEvidence = isRecord(input)
    ? (input.evidence as ApplicationGraphEvidence | undefined)
    : undefined;
  const parsed = javaScriptSemanticFingerprintInputSchema.parse(input);
  const semantic = {
    ...parsed,
    components: {
      ...parsed.components,
      effects: uniqueSorted(parsed.components.effects),
    },
    limitations: uniqueSorted(parsed.limitations),
    evidence: evidenceContexts[internValidatedEvidenceSymbol](
      parsed.evidence,
      rawEvidence,
    ),
  };
  const fingerprintSha256 = digestCanonicalValue(
    semantic.components,
    "JavaScript semantic graph",
  );
  return {
    ...semantic,
    fingerprint_sha256: fingerprintSha256,
    fingerprint_id: `jsrg_fingerprint_${digestCanonicalValue(
      {
        function_node_id: semantic.function_node_id,
        algorithm: semantic.algorithm,
        fingerprint_sha256: fingerprintSha256,
      },
      "JavaScript semantic graph",
    )}`,
  };
};

/** Normalize one function fingerprint and derive its component commitment. */
export const createJavaScriptSemanticFingerprint = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticFingerprint =>
  buildSemanticFingerprint(input, evidenceContexts);

/** Normalize and seal one exclusively owned function fingerprint. */
export const createOwnedJavaScriptSemanticFingerprint = (
  input: unknown,
  evidenceContexts: JavaScriptSemanticEvidenceContextRegistry,
): JavaScriptSemanticFingerprint =>
  sealSemanticFingerprint(buildSemanticFingerprint(input, evidenceContexts));

type GraphRecord = z.infer<typeof javaScriptSemanticGraphRecordSchema>;

type SemanticGraphIssue = {
  readonly code: "custom";
  readonly path: PropertyKey[];
  readonly message: string;
};

interface GraphIssueReporter {
  readonly addIssue: (issue: SemanticGraphIssue) => void;
}

const sortedUniqueIssue = (
  values: readonly string[],
  path: PropertyKey[],
  label: string,
  context: GraphIssueReporter,
): void => {
  for (let index = 1; index < values.length; index += 1) {
    if (
      compareUnicodeCodePoints(values[index - 1] ?? "", values[index] ?? "") < 0
    )
      continue;
    context.addIssue({
      code: "custom",
      path: [...path, index],
      message: `${label} must be sorted and unique`,
    });
    return;
  }
};

function* checkCoverageSteps(
  graph: GraphRecord,
  context: GraphIssueReporter,
): Generator<void> {
  const omittedUnknowns = graph.coverage.omitted_unknown_occurrences ?? [];
  sortedUniqueIssue(
    omittedUnknowns.map(({ family, reason }) => `${family}:${reason}`),
    ["coverage", "omitted_unknown_occurrences"],
    "Unknown omission coverage",
    context,
  );
  if (
    omittedUnknowns.length > 0 &&
    (!graph.coverage.truncated || graph.coverage.status !== "partial")
  )
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "Omitted unknown occurrences require truncated partial coverage",
    });
  const families = graph.coverage.families.map(({ family }) => family);
  if (
    canonicalJson(families, "JavaScript semantic graph") !==
    canonicalJson(
      JAVASCRIPT_SEMANTIC_RELATION_FAMILIES,
      "JavaScript semantic graph",
    )
  )
    context.addIssue({
      code: "custom",
      path: ["coverage", "families"],
      message:
        "Coverage must name every semantic relation family once in canonical order",
    });
  if (
    graph.coverage.status === "complete" &&
    (graph.coverage.truncated ||
      graph.coverage.omitted_nodes !== 0 ||
      graph.coverage.omitted_relations !== 0 ||
      graph.coverage.families.some(({ status }) => status !== "complete"))
  )
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message: "Complete graph coverage cannot omit or truncate semantic facts",
    });
  if (graph.coverage.truncated && graph.coverage.limits.length === 0)
    context.addIssue({
      code: "custom",
      path: ["coverage", "limits"],
      message: "Truncated graph coverage must identify an effective limit",
    });
  if (graph.coverage.truncated && graph.coverage.status !== "partial")
    context.addIssue({
      code: "custom",
      path: ["coverage", "status"],
      message: "Truncated semantic graph coverage must be partial",
    });
  if (
    graph.coverage.truncated &&
    graph.coverage.omitted_nodes === 0 &&
    graph.coverage.omitted_relations === 0 &&
    omittedUnknowns.length === 0
  )
    context.addIssue({
      code: "custom",
      path: ["coverage"],
      message:
        "Truncated semantic graph coverage must acknowledge omitted facts",
    });
  const relationsByFamily = new Map(
    JAVASCRIPT_SEMANTIC_RELATION_FAMILIES.map((family) => [family, 0]),
  );
  for (const [index, relation] of graph.relations.entries()) {
    if (index % 256 === 0) yield;
    const family = JAVASCRIPT_SEMANTIC_RELATION_FAMILY[relation.relation];
    relationsByFamily.set(family, (relationsByFamily.get(family) ?? 0) + 1);
  }
  const unknownsById = new Map<string, GraphRecord["unknowns"][number]>();
  const unknownFamilies = new Set<string>();
  for (const [index, unknown] of graph.unknowns.entries()) {
    if (index % 256 === 0) yield;
    unknownsById.set(unknown.unknown_id, unknown);
    unknownFamilies.add(unknown.family);
  }
  for (const [index, family] of graph.coverage.families.entries()) {
    if (family.retained_relations !== relationsByFamily.get(family.family))
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index, "retained_relations"],
        message: "Family retained relation count does not match graph content",
      });
    if (
      family.unknown_ids.some(
        (identifier) => unknownsById.get(identifier)?.family !== family.family,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index, "unknown_ids"],
        message: "Family coverage references an unknown from another family",
      });
    if (
      family.status === "complete" &&
      (family.omitted_relations !== 0 ||
        family.unknown_ids.length > 0 ||
        unknownFamilies.has(family.family) ||
        omittedUnknowns.some((omitted) => omitted.family === family.family))
    )
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index],
        message: "Complete family coverage cannot omit or retain unknown facts",
      });
  }
}

const checkCanonicalOrder = (
  graph: GraphRecord,
  context: GraphIssueReporter,
): void => {
  sortedUniqueIssue(
    graph.root_node_ids,
    ["root_node_ids"],
    "Root nodes",
    context,
  );
  sortedUniqueIssue(
    graph.evidence_contexts.map(({ context_id }) => context_id),
    ["evidence_contexts"],
    "Evidence contexts",
    context,
  );
  sortedUniqueIssue(
    graph.nodes.map(({ node_id }) => node_id),
    ["nodes"],
    "Nodes",
    context,
  );
  sortedUniqueIssue(
    graph.relations.map(({ relation_id }) => relation_id),
    ["relations"],
    "Relations",
    context,
  );
  sortedUniqueIssue(
    graph.fingerprints.map(({ fingerprint_id }) => fingerprint_id),
    ["fingerprints"],
    "Fingerprints",
    context,
  );
  sortedUniqueIssue(
    graph.unknowns.map(({ unknown_id }) => unknown_id),
    ["unknowns"],
    "Unknown frontiers",
    context,
  );
  sortedUniqueIssue(graph.limitations, ["limitations"], "Limitations", context);
};

function* checkEvidenceContextReferencesSteps(
  graph: GraphRecord,
  context: GraphIssueReporter,
): Generator<void> {
  const contexts = new Map<
    string,
    {
      readonly value: JavaScriptSemanticEvidenceContext;
      readonly validContext: boolean;
    }
  >();
  for (const value of graph.evidence_contexts) {
    const { context_id: _contextId, ...evidenceValue } = value;
    contexts.set(value.context_id, {
      value,
      validContext: isValidApplicationGraphEvidenceContext(evidenceValue),
    });
  }
  const referenced = new Set<string>();
  const validateReferences = function* (
    entities: readonly { evidence: JavaScriptSemanticEvidenceReference }[],
    entityKind: "nodes" | "relations" | "unknowns" | "fingerprints",
  ): Generator<void> {
    for (const [index, { evidence }] of entities.entries()) {
      if (index % 256 === 0) yield;
      referenced.add(evidence.context_id);
      const entry = contexts.get(evidence.context_id);
      if (entry === undefined) {
        context.addIssue({
          code: "custom",
          path: [entityKind, index, "evidence", "context_id"],
          message: "Evidence reference names an absent context",
        });
        continue;
      }
      if (
        !entry.validContext ||
        !isCompatibleApplicationGraphEvidenceLocation(
          entry.value,
          evidence.location,
        )
      )
        context.addIssue({
          code: "custom",
          path: [entityKind, index, "evidence"],
          message: "Evidence context is incompatible with its fact location",
        });
    }
  };
  yield* validateReferences(graph.nodes, "nodes");
  yield* validateReferences(graph.relations, "relations");
  yield* validateReferences(graph.unknowns, "unknowns");
  yield* validateReferences(graph.fingerprints, "fingerprints");
  for (const [index, evidenceContext] of graph.evidence_contexts.entries()) {
    if (index % 256 === 0) yield;
    const { context_id: identifier, ...value } = evidenceContext;
    if (
      !validatedSemanticEvidenceContexts.has(evidenceContext) &&
      identifier !== evidenceContextId(value)
    )
      context.addIssue({
        code: "custom",
        path: ["evidence_contexts", index, "context_id"],
        message: "Evidence context identifier is stale",
      });
    if (!referenced.has(identifier))
      context.addIssue({
        code: "custom",
        path: ["evidence_contexts", index],
        message: "Evidence context is not referenced by a graph fact",
      });
  }
}

function* checkNodesSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, node] of graph.nodes.entries()) {
    if (index % 256 === 0) yield;
    if (
      !validatedSemanticNodes.has(node) &&
      node.node_id !== javaScriptSemanticNodeId(node)
    )
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "node_id"],
        message: "Node identifier is stale",
      });
    if (
      node.function_node_id !== null &&
      nodes.get(node.function_node_id)?.kind !== "function"
    )
      context.addIssue({
        code: "custom",
        path: ["nodes", index, "function_node_id"],
        message: "Function owner must name a function node",
      });
  }
}

function* checkRootsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, root] of graph.root_node_ids.entries()) {
    if (index % 256 === 0) yield;
    if (!nodes.has(root))
      context.addIssue({
        code: "custom",
        path: ["root_node_ids"],
        message: "Root identifier must name a semantic node",
      });
  }
}

function* checkRelationsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  evidenceContexts: ReadonlyMap<string, JavaScriptSemanticEvidenceContext>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, relation] of graph.relations.entries()) {
    if (index % 256 === 0) yield;
    if (!validatedSemanticRelations.has(relation)) {
      const { relation_id: identifier, ...semantic } = relation;
      if (
        identifier !==
        "jsrg_relation_" +
          digestCanonicalValue(semantic, "JavaScript semantic graph")
      )
        context.addIssue({
          code: "custom",
          path: ["relations", index, "relation_id"],
          message: "Relation identifier is stale",
        });
    }
    if (
      !nodes.has(relation.source_node_id) ||
      !nodes.has(relation.target_node_id)
    )
      context.addIssue({
        code: "custom",
        path: ["relations", index],
        message: "Relation endpoints must name semantic nodes",
      });
    if (relation.source_node_id === relation.target_node_id)
      context.addIssue({
        code: "custom",
        path: ["relations", index],
        message: "Semantic relations cannot be self-referential",
      });
    if (
      relation.resolution === "candidate" &&
      evidenceContexts.get(relation.evidence.context_id)?.state === "observed"
    )
      context.addIssue({
        code: "custom",
        path: ["relations", index, "evidence", "state"],
        message: "Candidate relations cannot claim observed resolution",
      });
  }
}

function* checkUnknownsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  evidenceContexts: ReadonlyMap<string, JavaScriptSemanticEvidenceContext>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, unknown] of graph.unknowns.entries()) {
    if (index % 256 === 0) yield;
    if (!validatedSemanticUnknowns.has(unknown)) {
      const { unknown_id: identifier, ...semantic } = unknown;
      if (
        identifier !==
        "jsrg_unknown_" +
          digestCanonicalValue(semantic, "JavaScript semantic graph")
      )
        context.addIssue({
          code: "custom",
          path: ["unknowns", index, "unknown_id"],
          message: "Unknown frontier identifier is stale",
        });
    }
    if (unknown.node_id !== null && !nodes.has(unknown.node_id))
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "node_id"],
        message: "Unknown frontier node is absent",
      });
    if (unknown.candidate_node_ids.some((nodeId) => !nodes.has(nodeId)))
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "candidate_node_ids"],
        message: "Unknown frontier candidate node is absent",
      });
    if (
      unknown.relation_kinds.some(
        (kind) => JAVASCRIPT_SEMANTIC_RELATION_FAMILY[kind] !== unknown.family,
      )
    )
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "relation_kinds"],
        message: "Unknown relation kinds must belong to their declared family",
      });
    const evidenceState = evidenceContexts.get(
      unknown.evidence.context_id,
    )?.state;
    if (evidenceState !== "unknown" && evidenceState !== "unavailable")
      context.addIssue({
        code: "custom",
        path: ["unknowns", index, "evidence", "state"],
        message: "Unknown frontiers require unknown or unavailable evidence",
      });
  }
}

const checkUnknownReferences = (
  graph: GraphRecord,
  context: GraphIssueReporter,
): void => {
  const unknownIds = new Set(
    graph.unknowns.map(({ unknown_id }) => unknown_id),
  );
  for (const [index, family] of graph.coverage.families.entries())
    if (family.unknown_ids.some((identifier) => !unknownIds.has(identifier)))
      context.addIssue({
        code: "custom",
        path: ["coverage", "families", index, "unknown_ids"],
        message: "Family coverage references an absent unknown frontier",
      });
};

function* checkFingerprintsSteps(
  graph: GraphRecord,
  nodes: ReadonlyMap<string, JavaScriptSemanticGraphNode>,
  context: GraphIssueReporter,
): Generator<void> {
  for (const [index, fingerprint] of graph.fingerprints.entries()) {
    if (index % 256 === 0) yield;
    if (nodes.get(fingerprint.function_node_id)?.kind !== "function")
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "function_node_id"],
        message: "Fingerprint must name a function node",
      });
    if (!validatedSemanticFingerprints.has(fingerprint)) {
      if (
        fingerprint.fingerprint_sha256 !==
        digestCanonicalValue(
          fingerprint.components,
          "JavaScript semantic graph",
        )
      )
        context.addIssue({
          code: "custom",
          path: ["fingerprints", index, "fingerprint_sha256"],
          message: "Fingerprint component commitment is stale",
        });
      const expectedIdentifier =
        "jsrg_fingerprint_" +
        digestCanonicalValue(
          {
            function_node_id: fingerprint.function_node_id,
            algorithm: fingerprint.algorithm,
            fingerprint_sha256: fingerprint.fingerprint_sha256,
          },
          "JavaScript semantic graph",
        );
      if (fingerprint.fingerprint_id !== expectedIdentifier)
        context.addIssue({
          code: "custom",
          path: ["fingerprints", index, "fingerprint_id"],
          message: "Fingerprint identifier is stale",
        });
    }
    if (
      fingerprint.status !== "complete" &&
      fingerprint.limitations.length === 0
    )
      context.addIssue({
        code: "custom",
        path: ["fingerprints", index, "limitations"],
        message: "Incomplete fingerprints require a limitation",
      });
  }
}

function* checkGraphContentSteps(
  graph: GraphRecord,
  context: GraphIssueReporter,
): Generator<void> {
  checkCanonicalOrder(graph, context);
  yield* checkEvidenceContextReferencesSteps(graph, context);
  const evidenceContexts = new Map(
    graph.evidence_contexts.map((evidenceContext) => [
      evidenceContext.context_id,
      evidenceContext,
    ]),
  );
  const nodes = new Map<string, JavaScriptSemanticGraphNode>();
  for (const [index, node] of graph.nodes.entries()) {
    if (index % 256 === 0) yield;
    nodes.set(node.node_id, node);
  }
  yield* checkNodesSteps(graph, nodes, context);
  yield* checkRootsSteps(graph, nodes, context);
  yield* checkRelationsSteps(graph, nodes, evidenceContexts, context);
  yield* checkUnknownsSteps(graph, nodes, evidenceContexts, context);
  checkUnknownReferences(graph, context);
  yield* checkFingerprintsSteps(graph, nodes, context);
  yield* checkCoverageSteps(graph, context);
  if (graph.coverage.status !== "complete" && graph.limitations.length === 0)
    context.addIssue({
      code: "custom",
      path: ["limitations"],
      message: "Non-complete graph coverage requires a limitation",
    });
}

const checkGraphContent = (
  graph: GraphRecord,
  context: GraphIssueReporter,
): void => {
  const steps = checkGraphContentSteps(graph, context);
  while (!steps.next().done) {
    // Synchronous callers apply the same integrity checks without scheduling.
  }
};

const checkGraph = (graph: GraphRecord, context: GraphIssueReporter): void => {
  checkGraphContent(graph, context);
  const { graph_id: identifier, ...semantic } = graph;
  if (
    identifier !==
    "jsrg_" + digestCanonicalValue(semantic, "JavaScript semantic graph")
  )
    context.addIssue({
      code: "custom",
      path: ["graph_id"],
      message: "Graph identifier is stale",
    });
};

/** Strict semantic graph schema with verified canonical commitments. */
export const javaScriptSemanticGraphSchema =
  javaScriptSemanticGraphRecordSchema.superRefine(checkGraph);

/** Fully validated JavaScript Semantic Relation Graph. */
export type JavaScriptSemanticGraph = z.infer<
  typeof javaScriptSemanticGraphSchema
>;

const normalizeGraphInput = (
  parsed: JavaScriptSemanticGraphInput,
): JavaScriptSemanticGraphInput => ({
  ...parsed,
  root_node_ids: uniqueSorted(parsed.root_node_ids),
  evidence_contexts: [...parsed.evidence_contexts].sort((left, right) =>
    compareUnicodeCodePoints(left.context_id, right.context_id),
  ),
  nodes: [...parsed.nodes].sort((left, right) =>
    compareUnicodeCodePoints(left.node_id, right.node_id),
  ),
  relations: [...parsed.relations].sort((left, right) =>
    compareUnicodeCodePoints(left.relation_id, right.relation_id),
  ),
  fingerprints: [...parsed.fingerprints].sort((left, right) =>
    compareUnicodeCodePoints(left.fingerprint_id, right.fingerprint_id),
  ),
  unknowns: [...parsed.unknowns].sort((left, right) =>
    compareUnicodeCodePoints(left.unknown_id, right.unknown_id),
  ),
  coverage: {
    ...parsed.coverage,
    limits: [...parsed.coverage.limits].sort((left, right) =>
      compareUnicodeCodePoints(
        canonicalJson(left, "JavaScript semantic graph"),
        canonicalJson(right, "JavaScript semantic graph"),
      ),
    ),
    ...(parsed.coverage.omitted_unknown_occurrences === undefined
      ? {}
      : {
          omitted_unknown_occurrences: [
            ...parsed.coverage.omitted_unknown_occurrences,
          ].sort((left, right) =>
            compareUnicodeCodePoints(
              `${left.family}:${left.reason}`,
              `${right.family}:${right.reason}`,
            ),
          ),
        }),
    families: [...parsed.coverage.families]
      .map((family) => ({
        ...family,
        unknown_ids: uniqueSorted(family.unknown_ids),
      }))
      .sort((left, right) =>
        compareUnicodeCodePoints(left.family, right.family),
      ),
  },
  limitations: uniqueSorted(parsed.limitations),
});

const parseElementsSync = <Element extends z.ZodType>(
  element: Element,
  values: readonly unknown[],
  path: readonly PropertyKey[],
  issues: z.core.$ZodIssue[],
  isPrevalidated?: (value: unknown) => value is z.output<Element>,
): z.output<Element>[] => {
  const steps = parseElementSteps(
    element,
    values,
    path,
    issues,
    isPrevalidated,
  );
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
};

/** Normalize a complete companion graph and derive its graph ID. */
export const createJavaScriptSemanticGraph = (
  input: unknown,
): JavaScriptSemanticGraph => {
  const container = semanticGraphContainerSchema.parse(input);
  const parseIssues: z.core.$ZodIssue[] = [];
  const parsed: JavaScriptSemanticGraphInput = {
    ...container,
    evidence_contexts: parseElementsSync(
      semanticGraphShape.evidence_contexts.element,
      container.evidence_contexts,
      ["evidence_contexts"],
      parseIssues,
      isValidatedSemanticEvidenceContext,
    ),
    nodes: parseElementsSync(
      semanticGraphShape.nodes.element,
      container.nodes,
      ["nodes"],
      parseIssues,
      isValidatedSemanticNode,
    ),
    relations: parseElementsSync(
      semanticGraphShape.relations.element,
      container.relations,
      ["relations"],
      parseIssues,
      isValidatedSemanticRelation,
    ),
    fingerprints: parseElementsSync(
      semanticGraphShape.fingerprints.element,
      container.fingerprints,
      ["fingerprints"],
      parseIssues,
      isValidatedSemanticFingerprint,
    ),
    unknowns: parseElementsSync(
      semanticGraphShape.unknowns.element,
      container.unknowns,
      ["unknowns"],
      parseIssues,
      isValidatedSemanticUnknown,
    ),
  };
  if (parseIssues.length > 0) throw new z.ZodError(parseIssues);
  const semantic = normalizeGraphInput(parsed);
  // The input schema or factory sealing already validated every field. Validate
  // normalized relationships in place, then derive the only added field. The
  // public schema still verifies arbitrary records and their commitments.
  const record: GraphRecord = {
    ...semantic,
    graph_id: `jsrg_${digestCanonicalValue(semantic, "JavaScript semantic graph")}`,
  };
  const issues: SemanticGraphIssue[] = [];
  checkGraphContent(record, {
    addIssue: (issue) => {
      issues.push(issue);
    },
  });
  if (issues.length > 0) throw new z.ZodError(issues);
  return record;
};

const validatedImmutableSemanticGraphs = new WeakSet<object>();

const semanticGraphShape = javaScriptSemanticGraphInputSchema.shape;
const semanticGraphContainerSchema = javaScriptSemanticGraphInputSchema.extend({
  evidence_contexts: arrayContainerSchema(semanticGraphShape.evidence_contexts),
  nodes: arrayContainerSchema(semanticGraphShape.nodes),
  relations: arrayContainerSchema(semanticGraphShape.relations),
  fingerprints: arrayContainerSchema(semanticGraphShape.fingerprints),
  unknowns: arrayContainerSchema(semanticGraphShape.unknowns),
});

/**
 * Seal a graph whose input the caller transfers: the caller neither retains nor
 * mutates any part of it afterwards. Only the graph's own fields are validated
 * synchronously; collection elements are validated and cloned in steps, because
 * a whole-graph parse of a large application held the event loop for seconds.
 */
export const sealTransferredJavaScriptSemanticGraphSteps = (
  input: unknown,
): Generator<void, JavaScriptSemanticGraph> =>
  parseAndSealSemanticGraphSteps(semanticGraphContainerSchema.parse(input));

function* parseAndSealSemanticGraphSteps(
  container: z.output<typeof semanticGraphContainerSchema>,
): Generator<void, JavaScriptSemanticGraph> {
  const issues: z.core.$ZodIssue[] = [];
  const parsed: JavaScriptSemanticGraphInput = {
    ...container,
    evidence_contexts: yield* parseElementSteps(
      semanticGraphShape.evidence_contexts.element,
      container.evidence_contexts,
      ["evidence_contexts"],
      issues,
      isValidatedSemanticEvidenceContext,
    ),
    nodes: yield* parseElementSteps(
      semanticGraphShape.nodes.element,
      container.nodes,
      ["nodes"],
      issues,
      isValidatedSemanticNode,
    ),
    relations: yield* parseElementSteps(
      semanticGraphShape.relations.element,
      container.relations,
      ["relations"],
      issues,
      isValidatedSemanticRelation,
    ),
    fingerprints: yield* parseElementSteps(
      semanticGraphShape.fingerprints.element,
      container.fingerprints,
      ["fingerprints"],
      issues,
      isValidatedSemanticFingerprint,
    ),
    unknowns: yield* parseElementSteps(
      semanticGraphShape.unknowns.element,
      container.unknowns,
      ["unknowns"],
      issues,
      isValidatedSemanticUnknown,
    ),
  };
  if (issues.length > 0) throw new z.ZodError(issues);
  return yield* validateAndSealSemanticGraphSteps(normalizeGraphInput(parsed));
}

function* validateAndSealSemanticGraphSteps(
  semantic: JavaScriptSemanticGraphInput,
): Generator<void, JavaScriptSemanticGraph> {
  const graph: GraphRecord = {
    ...semantic,
    graph_id: `jsrg_${yield* canonicalJsonDigestSteps(semantic)}`,
  };
  const issues: SemanticGraphIssue[] = [];
  yield* checkGraphContentSteps(graph, {
    addIssue: (issue) => {
      issues.push(issue);
    },
  });
  if (issues.length > 0) throw new z.ZodError(issues);
  yield* freezeOwnedJsonSnapshotSteps(graph);
  validatedImmutableSemanticGraphs.add(graph);
  return graph;
}

/** Recognize the exact completely sealed graph produced by the owned factory. */
export const isValidatedImmutableJavaScriptSemanticGraph = (
  value: unknown,
): value is JavaScriptSemanticGraph =>
  typeof value === "object" &&
  value !== null &&
  validatedImmutableSemanticGraphs.has(value);
