import { jsonTextCodeUnits } from "../jsonSerialization.js";
import type { JsonValue } from "../jsonValue.js";
import {
  collectionPathOf,
  isObject,
  isParam,
  normalizedPath,
  scalarText,
  segmentsOf,
  selectedCollection,
  type JsonObject,
  type StateEntity,
  type SuppliedSegment,
} from "./environmentStateRules.js";
import {
  createdFields,
  recordedGeneratedValue,
} from "./environmentStateWriteApply.js";
import {
  createdToken,
  isOpaqueToken,
  restampedFields,
} from "./environmentStateWriteStamps.js";
import {
  recordedPathValues,
  respondedIds,
  sameLinkedSource,
} from "./environmentStateWriteLinks.js";
import {
  collectionTarget,
  entityTarget,
} from "./environmentStateWriteChecks.js";
import {
  built,
  callOf,
  fail,
  itemReads,
  refuse,
  requestBodyPlan,
  retainFixed,
  searchFrom,
  startOf,
  UNKNOWN,
  type EffectContext,
  type EffectResult,
  type WriteDraft,
  type WriteStep,
} from "./environmentStateWriteEffects.js";
import {
  explainCreate,
  insertCandidates,
  insertIndex,
  randomIdentities,
  nextInteger,
  responseShapeOf,
} from "./environmentStateWriteExplain.js";
import {
  laterObservation,
  newEntityIn,
  type Observed,
} from "./environmentStateWriteObserve.js";
import {
  pathValuesOf,
  type FieldRule,
  type WriteCall,
} from "./environmentStateWriteRules.js";
import {
  isUuid,
  nextSequence,
  readClock,
  sequenceNumber,
  spelledLike,
} from "./environmentStateWriteValues.js";

/** The id a response names alone: a scalar body, or an object's id field or single scalar member. */
const respondedId = (
  body: JsonValue | undefined,
  idField: string,
): string | undefined => {
  if (body === undefined) return undefined;
  if (!isObject(body)) return scalarText(body);
  if (Object.hasOwn(body, idField)) return scalarText(body[idField]);
  const members = Object.values(body);
  return members.length === 1 ? scalarText(members[0]) : undefined;
};

/**
 * The written entity a create's response or a later read shows. A linked create's read must name an
 * id its response returned, as the read that linked it did, envelopes included.
 */
const createdObservation = (
  context: EffectContext,
  step: WriteStep,
  target: {
    readonly type: string;
    readonly collection: string;
    readonly idField: string;
    readonly linked: boolean;
  },
): Observed | undefined => {
  const held = (id: string) =>
    context.state.entity(target.type, target.collection, id) !== undefined;
  const own = context.io.withBody(step.record.ordinal, (body) =>
    newEntityIn(step.record.ordinal, body, target.idField, held),
  );
  if (own !== undefined) return own;
  const { id, ids } = context.io.withBody(step.record.ordinal, (body) => {
    const returned = target.linked ? respondedIds(body) : [];
    // A response that names the created id alone ties the later read to that id.
    const named =
      respondedId(body, target.idField) ??
      (returned.length === 1 ? returned[0] : undefined);
    return { id: named, ids: returned };
  });
  const later = laterObservation(searchFrom(context, step), {
    type: target.type,
    collection: target.collection,
    idField: target.idField,
    ...(id === undefined ? {} : { id }),
    held,
    isWrite: context.isWrite,
  });
  // A read named by the id is tied already; otherwise a linked create's read must name a returned id.
  if (
    later === undefined ||
    (target.linked && id === undefined && !ids.includes(later.id))
  )
    return undefined;
  context.observed(later.ordinal);
  return later;
};

const fieldsOf = (entities: readonly StateEntity[]): JsonObject[] =>
  entities.map((entity) => entity.fields);

/** Build a create plan from its exemplar's observation. */
const buildCreate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
  evidence: {
    readonly observed: Observed;
    readonly call: WriteCall & { readonly body: JsonObject };
    readonly collection: string;
    readonly envelope: string | undefined;
  },
): boolean => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  const members = fieldsOf(context.state.members(type, evidence.collection));
  const held = fieldsOf(context.state.ofType(type));
  const explained = explainCreate({
    entity: evidence.observed.object,
    call: evidence.call,
    idField,
    startMs: startOf(context, step),
    collection: members,
    type: held,
    named: (id) => context.state.named(id),
  });
  const explainedFields = new Set(explained.rules.map((rule) => rule.field));
  if (
    Object.keys(evidence.observed.object).some(
      (field) =>
        !explainedFields.has(field) &&
        createdToken(field, evidence.observed.object, held) === "linked",
    )
  ) {
    refuse(draft, step, "unexplained-change");
    return false;
  }
  const clocks = explained.rules.flatMap((rule) =>
    rule.rule === "clock" ? [rule.field] : [],
  );
  // Identity and clock orders first, then any other scalar field the collection may be sorted by.
  const scalars = Object.keys(members[0] ?? {}).filter((field) =>
    members.every((member) =>
      ["string", "number"].includes(typeof member[field]),
    ),
  );
  const generated = explained.rules.some(
    (rule) =>
      rule.rule === "identity" &&
      rule.field === idField &&
      rule.generator !== "sequence",
  );
  draft.candidates = insertCandidates(
    members,
    [...new Set([idField, ...clocks, ...scalars])],
    {
      ...(generated && randomIdentities(members, idField, clocks)
        ? { random: idField }
        : {}),
      created: evidence.observed.object,
    },
  );
  retainFixed(context, explained.body.fixed);
  Object.assign(draft.plan, {
    exemplar_ordinal: step.record.ordinal,
    observation: {
      ordinal: evidence.observed.ordinal,
      pointer: evidence.observed.pointer,
    },
    response: context.io.withBody(step.record.ordinal, (body) =>
      responseShapeOf(
        step.record.ordinal,
        body,
        context.io.emptyResponse(step.record.ordinal),
        { idField, id: evidence.observed.id },
      ),
    ),
    body: {
      ...explained.body,
      ...(evidence.envelope === undefined
        ? {}
        : { envelope: evidence.envelope }),
    },
    rules: explained.rules,
    collection:
      explained.tied || draft.linked !== undefined ? evidence.collection : null,
    insert: draft.candidates[0]!,
  });
  draft.observed = evidence.observed.object;
  return true;
};

type SequenceRule = Extract<FieldRule, { rule: "sequence" }>;

/** The sequences a create's plan generates, each with the key serving counts it under. */
const sequencesOf = (
  draft: WriteDraft,
  collection: string,
): { readonly rule: SequenceRule; readonly key: string }[] =>
  draft.plan.rules.flatMap((rule) =>
    rule.rule === "sequence"
      ? [
          {
            rule,
            key:
              rule.scope === "collection"
                ? `${rule.field} ${collection}`
                : rule.field,
          },
        ]
      : [],
  );

/** Whether a later call's sequences hold what serving generates: one past the largest value their scope holds or started with and past the plan's last, spelled as the exemplar spells it. */
const followsSequences = (
  context: EffectContext,
  draft: WriteDraft,
  created: Pick<StateEntity, "type" | "collection" | "fields">,
): boolean =>
  sequencesOf(draft, created.collection).every(({ rule, key }) => {
    const scope = [
      ...context.state.ofType(created.type),
      ...context.startedWith(created.type),
    ].filter(
      (entity) =>
        rule.scope === "type" || entity.collection === created.collection,
    );
    const next = nextSequence(
      nextInteger(fieldsOf(scope), rule.field, draft.observed?.[rule.field]),
      draft.sequences.get(key),
    );
    return (
      created.fields[rule.field] ===
      spelledLike(draft.observed?.[rule.field] ?? "", next)
    );
  });

/** Whether a later call's generated values take the forms serving generates them in: clocks in the learned format, unique values as the exemplar's kind of token, UUID identities as UUIDs, and sequences in order. */
const followsGenerated = (
  context: EffectContext,
  draft: WriteDraft,
  created: Pick<StateEntity, "type" | "collection" | "fields">,
): boolean =>
  draft.plan.rules.every((rule) => {
    const value = created.fields[rule.field];
    if (rule.rule === "clock")
      return (
        JSON.stringify(readClock(value)?.format) === JSON.stringify(rule.format)
      );
    if (rule.rule === "unique")
      return (
        (isUuid(value) || isOpaqueToken(value, draft.observed?.[rule.field])) &&
        !context.state
          .ofType(created.type)
          .some((held) => held.fields[rule.field] === value)
      );
    return (
      rule.rule !== "identity" || rule.generator !== "uuid" || isUuid(value)
    );
  }) && followsSequences(context, draft, created);

/** Record the values a create's sequences took, which the next call follows. */
const takeSequences = (
  draft: WriteDraft,
  created: Pick<StateEntity, "collection" | "fields">,
): void => {
  for (const { rule, key } of sequencesOf(draft, created.collection)) {
    const value = sequenceNumber(
      created.fields[rule.field],
      draft.observed?.[rule.field],
    );
    if (value !== undefined) draft.sequences.set(key, value);
  }
};

/** Segments of a recorded path as a create call supplies them: template literals, and each parameter's recorded spelling. */
const recordedSegments = (
  template: string,
  path: string,
): SuppliedSegment[] | undefined => {
  const pattern = segmentsOf(template);
  const concrete = segmentsOf(path);
  if (pattern.length !== concrete.length) return undefined;
  const segments: SuppliedSegment[] = [];
  for (const [index, part] of pattern.entries()) {
    const value = concrete[index]!;
    if (!isParam(part)) {
      if (part !== value) return undefined;
      segments.push({ text: part, supplied: false });
      continue;
    }
    if (value.length === 0) return undefined;
    segments.push({ text: value, supplied: true });
  }
  return segments;
};

/** Collections a create may join, in serving's order: held ones, then emptied ones as first known, then checked list lines. */
const createCandidates = (context: EffectContext, type: string): string[] => {
  const candidates: string[] = [];
  const seen = new Set<string>();
  const add = (collection: string): void => {
    if (seen.has(collection)) return;
    seen.add(collection);
    candidates.push(collection);
  };
  for (const entity of context.state.ofType(type)) add(entity.collection);
  for (const collection of context.state.knownCollections(type))
    add(collection);
  for (const record of context.records) {
    const view = context.viewOf(record.ordinal);
    if (
      view?.shape === "list" &&
      view.type === type &&
      view.checked_record_ordinals.includes(record.ordinal)
    )
      add(collectionPathOf(record, false));
  }
  return candidates;
};

/** The collection serving would write this recorded create into, when the path instantiates the tool. */
const servedCollection = (
  context: EffectContext,
  step: WriteStep,
  type: string,
): string | undefined => {
  const segments = recordedSegments(step.tool.path_template, step.record.path);
  return segments === undefined
    ? undefined
    : selectedCollection(segments, createCandidates(context, type));
};

/** Whether a linked create's call sends the source path values its exemplar did, the only ones its link holds for. */
const fromLinkedSource = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): boolean =>
  sameLinkedSource(
    step.tool.path_template,
    context.records.find(
      (record) => record.ordinal === draft.plan.exemplar_ordinal,
    )?.path,
    recordedPathValues(step.tool.path_template, step.record.path),
  );

/** Add a created entity to the state at the plan's insert position, or last before the plan has one. */
const insertCreated = (
  context: EffectContext,
  draft: WriteDraft,
  entity: StateEntity,
): string => {
  const members = fieldsOf(
    context.state.members(entity.type, entity.collection),
  );
  context.io.retain(64 + jsonTextCodeUnits(entity.fields) * 2);
  context.state.put(
    entity,
    draft.plan.insert === null
      ? members.length
      : insertIndex(draft.plan.insert, members, entity.fields),
  );
  return entityTarget(entity.type, entity.collection, entity.id);
};

/** Apply a recorded create, with the values it recorded for generated fields; an unexplained create adds what it recorded. */
export const applyCreate = (
  context: EffectContext,
  draft: WriteDraft,
  step: WriteStep,
): EffectResult => {
  const type = draft.plan.target!;
  const idField = context.idField(type);
  const spelled = normalizedPath(step.record.path);
  // Serving writes a create into the collection it chooses for the path, and a tied plan refuses any other, so a create there is not counted.
  const collection =
    draft.linked ?? servedCollection(context, step, type) ?? spelled;
  // A linked plan's collection holds only for its exemplar's source path, so serving refuses any other.
  if (
    built(draft) &&
    ((draft.plan.collection !== null && draft.plan.collection !== collection) ||
      (draft.linked !== undefined && !fromLinkedSource(context, draft, step)))
  )
    return UNKNOWN;
  const observed = createdObservation(context, step, {
    type,
    collection,
    idField,
    linked: draft.linked !== undefined,
  });
  const request = requestBodyPlan(context, step, draft, observed?.object);
  const body = request?.object;
  if (observed === undefined) {
    fail(draft, step, body === undefined ? "body-unusable" : "no-observation");
    return UNKNOWN;
  }
  const entity = (fields: JsonObject, id: string): StateEntity => ({
    type,
    collection,
    id,
    fields,
    view_fields: [],
    record_ordinals: [],
  });
  const recorded = (): EffectResult => {
    const inserted = insertCreated(
      context,
      draft,
      entity(observed.object, observed.id),
    );
    return {
      kind: "observed",
      targets: [inserted, collectionTarget(type, collection)],
      entity: { type, collection, id: observed.id },
    };
  };
  if (step.observeOnly || body === undefined) {
    fail(draft, step, "body-unusable");
    return recorded();
  }
  const call = { ...callOf(step, body), body };
  // The exemplar defines the plan's sequences; each later call must follow them.
  const later = built(draft);
  if (
    later &&
    draft.plan.rules.some(
      (rule) =>
        rule.rule === "unique" &&
        createdToken(
          rule.field,
          observed.object,
          fieldsOf(context.state.ofType(type)),
        ) === "linked",
    )
  ) {
    refuse(draft, step, "unexplained-change");
    return recorded();
  }
  if (
    !later &&
    !buildCreate(context, draft, step, {
      observed,
      call,
      collection,
      envelope: request?.envelope,
    })
  )
    return recorded();
  // Rules learn from the recorded path; serving fills path fields from the collection it selects.
  const created = {
    ...call,
    pathValues:
      pathValuesOf(step.tool.path_template, collection) ?? call.pathValues,
  };
  const fields = createdFields(draft.plan, draft.observed!, created, (rule) =>
    recordedGeneratedValue(
      rule,
      draft.observed![rule.field],
      observed.object[rule.field] ?? null,
    ),
  );
  const id = fields.ok ? scalarText(fields.value[idField]) : undefined;
  if (
    !fields.ok ||
    id === undefined ||
    context.state.entity(type, collection, id) !== undefined ||
    (later &&
      !followsGenerated(context, draft, {
        type,
        collection,
        fields: fields.value,
      }))
  ) {
    refuse(draft, step, "unexplained-change");
    return recorded();
  }
  takeSequences(draft, { collection, fields: fields.value });
  // The call's own values follow the forms serving generates; the state holds a nested clock as the read-back restamped it, as an update's.
  const stored = restampedFields(
    searchFrom(context, step),
    itemReads(context, { type, idField, collection, id }),
    fields.value,
    draft.plan.rules,
  );
  const inserted = insertCreated(context, draft, entity(stored, id));
  return {
    kind: "applied",
    targets: [inserted, collectionTarget(type, collection)],
    entity: { type, collection, id },
    inserted,
  };
};
