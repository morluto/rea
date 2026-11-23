import {
  environmentCollectionKey,
  environmentEntityKey,
} from "../../domain/analysisView/environmentStateIdentity.js";
import {
  markedDeleted,
  type StateEntity,
  type StateType,
} from "../../domain/analysisView/environmentStateRules.js";
import { nextSequence } from "../../domain/analysisView/environmentStateWriteValues.js";
import {
  AnalysisInputError,
  AnalysisResourceConstraintError,
} from "../../domain/analysisErrorCore.js";
import { Budget } from "../../domain/budget.js";
import type { JsonValue } from "../../domain/jsonValue.js";
import { jsonByteLength } from "../../domain/jsonSerialization.js";
import { err, ok, type Result } from "../../domain/result.js";
import { ENVIRONMENT_SERVE_OPERATION } from "./environmentSource.js";
import type { EnvironmentState } from "./environmentState.js";
import {
  parseStateDocument,
  STATE_INTAKE_LIMIT_BYTES,
  type HeldDocument,
  type StateContent,
} from "./environmentStateDocument.js";

/** Maximum logical budget for collection spellings added by served creates since reset/load. */
const ENVIRONMENT_COLLECTION_HISTORY_LIMIT_BYTES = 1024 * 1024;

const collectionHistoryCost = (
  state: EnvironmentState,
  type: string,
  collection: string,
): number => {
  // Account key bytes without building temporary key strings or a Set.
  let sequenceBytes = 0;
  for (const plan of state.writes.values()) {
    if (!plan.served || plan.target !== type) continue;
    for (const rule of plan.rules) {
      if (rule.rule === "sequence" && rule.scope === "collection")
        sequenceBytes +=
          64 +
          Buffer.byteLength(plan.tool, "utf8") +
          1 +
          Buffer.byteLength(rule.field, "utf8") +
          1 +
          Buffer.byteLength(collection, "utf8");
      else if (rule.rule === "identity" && rule.generator === "sequence")
        sequenceBytes +=
          64 +
          Buffer.byteLength(type, "utf8") +
          1 +
          Buffer.byteLength(rule.field, "utf8") +
          1 +
          Buffer.byteLength(collection, "utf8");
    }
  }
  return 64 + Buffer.byteLength(collection, "utf8") + sequenceBytes;
};

/** What `data/get` reports: the current state as a `rea-state/v1` document. */
export interface StateSnapshot {
  readonly rea_state: {
    readonly version: 1;
    readonly state_evidence_id: string;
    readonly types: readonly StateType[];
    readonly entities: readonly StateEntity[];
    readonly documents: readonly HeldDocument[];
  };
}

/** The bytes JSON writes for these array items and the commas between them. */
const itemsBytes = (items: readonly unknown[]): number =>
  items.reduce<number>((sum, item) => sum + jsonByteLength(item), 0) +
  Math.max(0, items.length - 1);

/** What `data/get` reports for some content of a state. */
const snapshotOf = (
  state: EnvironmentState,
  entities: readonly StateEntity[],
  documents: readonly HeldDocument[],
): StateSnapshot => ({
  rea_state: {
    version: 1,
    state_evidence_id: state.evidenceId,
    types: state.types,
    entities,
    documents,
  },
});

/** What `data/get` writes for a state as the Evidence holds it, in UTF-8 bytes, summed item by item. */
export const initialStateBytes = (state: EnvironmentState): number =>
  jsonByteLength(snapshotOf(state, [], [])) +
  itemsBytes(state.entities) +
  itemsBytes(state.documents);

/**
 * The live state one served environment answers from, shared by every MCP
 * session and the data plane. Mutations are synchronous and swap the whole
 * state, so every answer reads one consistent state. A mutation that would take
 * what `data/get` reports past the size `data/add` loads is refused, so that
 * report always loads back.
 */
export class EnvironmentStateStore {
  #entities: Map<string, StateEntity> = new Map();
  #storedDeleted: Map<string, StateEntity> = new Map();
  #collections: Map<string, readonly StateEntity[]> = new Map();
  #typeCollections: Map<string, readonly string[]> = new Map();
  #collectionEntityCounts: Map<string, number> = new Map();
  #documents: Map<string, HeldDocument> = new Map();
  #content: StateContent = { entities: [], documents: [] };
  #entityIds: ReadonlySet<string> | undefined;
  readonly #types: ReadonlyMap<string, StateType>;
  readonly #clockStart: number;
  /** What `data/get` writes for the current state, in UTF-8 bytes; kept by each mutation rather than reserialized. */
  #bytes = 0;
  /** The bytes of `data/get` with no entities or documents. */
  readonly #frameBytes: number;
  readonly #initialBytes: number;
  /** Served writes since the state was last reset or loaded: the clock's seconds and the generators' counter. */
  #writes = 0;
  /** The largest value each sequence has generated since the last reset or load, so a deleted entity's value is not reused. */
  readonly #sequences = new Map<string, number>();
  /** The entities the state held when it was last reset or loaded, whose values no sequence reuses either. */
  #started: readonly StateEntity[] = [];
  /** The types a served create has added an entity to since the last reset or load. */
  readonly #createdTypes = new Set<string>();
  /** Baseline and post-start spellings kept known after their entities are deleted. */
  readonly #knownCollections = new Map<string, Set<string>>();
  /** Logical UTF-8 key bytes plus a 64-byte allowance per collection and potential sequence-key record. */
  #collectionHistoryBytes = 0;
  /** The collections of the Evidence's own state, which stay known after any load. */
  #evidenceCollections: ReadonlyMap<string, readonly string[]> = new Map();
  /** Entities served deletes kept for an application that still answers a deleted record by id, oldest first. */
  readonly #deleted = new Map<string, StateEntity>();
  /** Their UTF-8 bytes, kept within what `data/add` loads by dropping the oldest. */
  readonly #deletedBytes = new Budget(STATE_INTAKE_LIMIT_BYTES);

  constructor(readonly state: EnvironmentState) {
    this.#types = new Map(
      state.types.map((type) => [type.collection_template, type]),
    );
    this.#clockStart =
      state.writeClock === null ? 0 : Date.parse(state.writeClock);
    this.#frameBytes = jsonByteLength(snapshotOf(state, [], []));
    this.#initialBytes = initialStateBytes(state);
    this.reset();
  }

  /** Restore the initial state the Evidence holds; the clock and counter start again. */
  reset(): void {
    this.#install(this.state, this.#initialBytes);
    this.#evidenceCollections = new Map(this.#typeCollections);
    this.#restart();
  }

  /** Validate a caller-owned document and copy its JSON values before retaining them; the clock and counter start again. */
  replace(document: unknown): Result<void, AnalysisInputError> {
    return this.#replace(document, false);
  }

  /** Validate and retain a JSON document created exclusively by the serving boundary. */
  replaceOwnedDocument(document: unknown): Result<void, AnalysisInputError> {
    return this.#replace(document, true);
  }

  #replace(
    document: unknown,
    owned: boolean,
  ): Result<void, AnalysisInputError> {
    const content = parseStateDocument(this.state, document, owned);
    if (!content.ok) return content;
    // data/get writes members a document may omit, so the state it reports must still be one data/add loads.
    const bytes = this.#contentBytes(content.value);
    if (bytes > STATE_INTAKE_LIMIT_BYTES)
      return err(
        new AnalysisInputError(
          ENVIRONMENT_SERVE_OPERATION,
          {
            userMessage: `The state would exceed ${String(STATE_INTAKE_LIMIT_BYTES)} bytes as data/get writes it.`,
          },
          [
            {
              path: [],
              reason: "out_of_range",
              message: `would exceed ${String(STATE_INTAKE_LIMIT_BYTES)} bytes as data/get writes it`,
              maximum: STATE_INTAKE_LIMIT_BYTES,
            },
          ],
        ),
      );
    this.#install(content.value, bytes);
    this.#restart();
    return ok(undefined);
  }

  /** The write a served call would be: its number since the last reset or load, and its clock instant, one second past the previous applied write. */
  pendingWrite(): { readonly count: number; readonly clockMs: number } {
    const count = this.#writes + 1;
    return { count, clockMs: this.#clockStart + count * 1000 };
  }

  /** Count an applied write and keep the sequence values it took, so a refused call takes none. */
  commitWrite(sequences: ReadonlyMap<string, number>): void {
    this.#writes += 1;
    for (const [key, value] of sequences) {
      const taken = this.#sequences.get(key);
      // No earlier value leaves this one in place, including when it is negative.
      this.#sequences.set(
        key,
        taken === undefined ? value : Math.max(taken, value),
      );
    }
  }

  /** The next value of a sequence: the next held integer, else one past the later of that and the last value taken. */
  sequenceAfter(key: string, held: number | undefined): number {
    return nextSequence(held, this.#sequences.get(key));
  }

  #restart(): void {
    this.#writes = 0;
    this.#sequences.clear();
    this.#started = this.#content.entities;
    this.#createdTypes.clear();
    this.#knownCollections.clear();
    this.#collectionHistoryBytes = 0;
    this.#deleted.clear();
    this.#deletedBytes.restore(0);
    for (const [type, collections] of this.#typeCollections)
      for (const collection of collections)
        this.#rememberCollection(type, collection);
    for (const [type, collections] of this.#evidenceCollections)
      for (const collection of collections)
        this.#rememberCollection(type, collection);
  }

  #rememberCollection(type: string, collection: string): void {
    const known = this.#knownCollections.get(type) ?? new Set<string>();
    known.add(collection);
    this.#knownCollections.set(type, known);
  }

  /** The entities of a type the state held when it was last reset or loaded. */
  /** Whether a served create has added an entity of the type since the last reset or load. */
  createdInto(type: string): boolean {
    return this.#createdTypes.has(type);
  }

  startedWith(type: string): readonly StateEntity[] {
    return this.#started.filter((entity) => entity.type === type);
  }

  /** Every held entity of a type, in state order. */
  ofType(type: string): readonly StateEntity[] {
    return this.#content.entities.filter(
      (entity) => entity.type === type && !markedDeleted(entity.fields),
    );
  }

  /** Add an entity at `index` of its collection's order, unless the state would outgrow what `data/add` loads. */
  insert(
    entity: StateEntity,
    index: number,
  ): Result<void, AnalysisResourceConstraintError> {
    const key = environmentEntityKey(entity.type, entity.collection, entity.id);
    const replaced = this.#storedDeleted.get(key);
    const entities =
      replaced === undefined
        ? this.#content.entities
        : this.#content.entities.filter((held) => held !== replaced);
    const bytes = this.#grown(
      jsonByteLength(entity) -
        (replaced === undefined ? 0 : jsonByteLength(replaced)) +
        (replaced === undefined && entities.length > 0 ? 1 : 0),
    );
    if (!bytes.ok) return bytes;
    const known = this.#knownCollections.get(entity.type);
    const newCollectionBytes =
      known?.has(entity.collection) === true
        ? 0
        : collectionHistoryCost(this.state, entity.type, entity.collection);
    if (newCollectionBytes > 0) {
      const historyBytes = this.#collectionHistoryBytes + newCollectionBytes;
      if (historyBytes > ENVIRONMENT_COLLECTION_HISTORY_LIMIT_BYTES)
        return err(
          new AnalysisResourceConstraintError(
            ENVIRONMENT_SERVE_OPERATION,
            "capacity",
            "Served collection history would exceed its deterministic accounting budget",
            {
              max_collection_history_bytes:
                ENVIRONMENT_COLLECTION_HISTORY_LIMIT_BYTES,
              collection_history_bytes: historyBytes,
            },
            {
              retryable: false,
              remediationAction:
                "Reset the served state or load a smaller state to clear generated collection history, then use fewer distinct collection paths.",
            },
          ),
        );
    }
    const members = this.inCollection(entity.type, entity.collection);
    const anchor =
      index < members.length
        ? entities.indexOf(members[index]!)
        : members.length > 0
          ? entities.indexOf(members.at(-1)!) + 1
          : entities.length;
    const nextEntities = [
      ...entities.slice(0, anchor),
      entity,
      ...entities.slice(anchor),
    ];
    if (replaced !== undefined) {
      this.#install({ ...this.#content, entities: nextEntities }, bytes.value);
    } else {
      const collKey = environmentCollectionKey(entity.type, entity.collection);
      if (markedDeleted(entity.fields)) {
        this.#storedDeleted.set(key, entity);
      } else {
        this.#entities.set(key, entity);
        const nextMembers =
          index < members.length
            ? [...members.slice(0, index), entity, ...members.slice(index)]
            : [...members, entity];
        this.#collections.set(collKey, nextMembers);
      }
      const prevCount = this.#collectionEntityCounts.get(collKey) ?? 0;
      this.#collectionEntityCounts.set(collKey, prevCount + 1);
      if (prevCount === 0) {
        const existing = this.#typeCollections.get(entity.type);
        this.#typeCollections.set(
          entity.type,
          existing === undefined
            ? [entity.collection]
            : [...existing, entity.collection],
        );
      }
      this.#content = { ...this.#content, entities: nextEntities };
      this.#entityIds = undefined;
      this.#bytes = bytes.value;
    }
    if (newCollectionBytes > 0) {
      this.#rememberCollection(entity.type, entity.collection);
      this.#collectionHistoryBytes += newCollectionBytes;
    }
    this.#createdTypes.add(entity.type);
    return ok(undefined);
  }

  /** Replace a held entity's values in place, unless the state would outgrow what `data/add` loads. */
  update(entity: StateEntity): Result<void, AnalysisResourceConstraintError> {
    return this.updateAll([entity]);
  }

  /**
   * Replace held entities in one step, unless the state would outgrow what `data/add` loads; a refusal changes nothing.
   * `order` puts held entities, the replacements among them, in that order in the places they hold.
   */
  updateAll(
    entities: readonly StateEntity[],
    order: readonly StateEntity[] = [],
  ): Result<void, AnalysisResourceConstraintError> {
    const replaced = new Map<StateEntity, StateEntity>();
    for (const entity of entities) {
      const held = this.#entities.get(
        environmentEntityKey(entity.type, entity.collection, entity.id),
      );
      if (held !== undefined) replaced.set(held, entity);
    }
    if (replaced.size === 0) return ok(undefined);
    // Sized from the replacements installed, so an entity named twice counts once.
    let delta = 0;
    for (const [held, entity] of replaced)
      delta += jsonByteLength(entity) - jsonByteLength(held);
    const bytes = this.#grown(delta);
    if (!bytes.ok) return bytes;
    if (order.length > 0) {
      const key = (entity: StateEntity) =>
        environmentEntityKey(entity.type, entity.collection, entity.id);
      const placed = new Set(order.map(key));
      let next = 0;
      this.#install(
        {
          ...this.#content,
          entities: this.#content.entities.map((candidate) =>
            placed.has(key(candidate))
              ? order[next++]!
              : (replaced.get(candidate) ?? candidate),
          ),
        },
        bytes.value,
      );
      return ok(undefined);
    }
    const touchedCollections = new Set<string>();
    for (const [held, entity] of replaced) {
      const key = environmentEntityKey(
        entity.type,
        entity.collection,
        entity.id,
      );
      const collKey = environmentCollectionKey(entity.type, entity.collection);
      touchedCollections.add(collKey);
      if (markedDeleted(entity.fields)) {
        this.#entities.delete(key);
        this.#storedDeleted.set(key, entity);
      } else {
        this.#entities.set(key, entity);
      }
    }
    for (const collKey of touchedCollections) {
      const current = this.#collections.get(collKey);
      if (current === undefined) continue;
      const nextMembers: StateEntity[] = [];
      for (const member of current) {
        const updated = replaced.get(member) ?? member;
        if (!markedDeleted(updated.fields)) nextMembers.push(updated);
      }
      if (nextMembers.length === 0) this.#collections.delete(collKey);
      else this.#collections.set(collKey, nextMembers);
    }
    this.#content = {
      ...this.#content,
      entities: this.#content.entities.map(
        (candidate) => replaced.get(candidate) ?? candidate,
      ),
    };
    this.#entityIds = undefined;
    this.#bytes = bytes.value;
    return ok(undefined);
  }

  remove(entity: StateEntity, keep = false): void {
    this.removeAll([entity], keep);
  }

  /** Remove held entities in one step; with `keep`, a later item read can still find each as deleted. */
  removeAll(entities: readonly StateEntity[], keep = false): void {
    const held = new Set(
      entities.flatMap((entity) => {
        const found = this.#entities.get(
          environmentEntityKey(entity.type, entity.collection, entity.id),
        );
        return found === undefined ? [] : [found];
      }),
    );
    if (held.size === 0) return;
    const kept = this.#content.entities.filter(
      (candidate) => !held.has(candidate),
    );
    let bytes = this.#bytes;
    const touchedCollections = new Map<
      string,
      { readonly type: string; readonly collection: string; count: number }
    >();
    for (const entity of held) {
      bytes -= jsonByteLength(entity);
      this.#entities.delete(
        environmentEntityKey(entity.type, entity.collection, entity.id),
      );
      const collKey = environmentCollectionKey(entity.type, entity.collection);
      const entry = touchedCollections.get(collKey);
      if (entry !== undefined) entry.count += 1;
      else
        touchedCollections.set(collKey, {
          type: entity.type,
          collection: entity.collection,
          count: 1,
        });
    }
    // Each removed entity takes its separator, except the last one an emptied list had none for.
    bytes -= held.size - (kept.length === 0 ? 1 : 0);
    const typesToReorder = new Set<string>();
    for (const [collKey, { type, collection, count }] of touchedCollections) {
      const current = this.#collections.get(collKey);
      const removedFirst =
        current !== undefined && current.length > 0 && held.has(current[0]!);
      if (current !== undefined) {
        const nextMembers = current.filter((member) => !held.has(member));
        if (nextMembers.length === 0) this.#collections.delete(collKey);
        else this.#collections.set(collKey, nextMembers);
      }
      const nextCount =
        (this.#collectionEntityCounts.get(collKey) ?? 0) - count;
      if (nextCount <= 0) {
        this.#collectionEntityCounts.delete(collKey);
        const typeColls = this.#typeCollections.get(type);
        if (typeColls !== undefined) {
          const filtered = typeColls.filter((c) => c !== collection);
          if (filtered.length === 0) this.#typeCollections.delete(type);
          else this.#typeCollections.set(type, filtered);
        }
      } else {
        this.#collectionEntityCounts.set(collKey, nextCount);
        if (removedFirst && (this.#typeCollections.get(type)?.length ?? 0) > 1)
          typesToReorder.add(type);
      }
    }
    this.#content = { ...this.#content, entities: kept };
    for (const type of typesToReorder) {
      const seen = new Set<string>();
      const ordered: string[] = [];
      for (const candidate of kept) {
        if (candidate.type !== type || seen.has(candidate.collection)) continue;
        seen.add(candidate.collection);
        ordered.push(candidate.collection);
      }
      if (ordered.length === 0) this.#typeCollections.delete(type);
      else this.#typeCollections.set(type, ordered);
    }
    this.#entityIds = undefined;
    this.#bytes = bytes;
    if (keep) for (const entity of held) this.#keepDeleted(entity);
  }

  /** An entity a served delete removed and kept, unless the state holds one under its key again. */
  deleted(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    const key = environmentEntityKey(type, collection, id);
    return this.#entities.has(key)
      ? undefined
      : (this.#storedDeleted.get(key) ?? this.#deleted.get(key));
  }

  #keepDeleted(entity: StateEntity): void {
    const key = environmentEntityKey(entity.type, entity.collection, entity.id);
    const earlier = this.#deleted.get(key);
    if (earlier !== undefined) {
      this.#deleted.delete(key);
      this.#deletedBytes.refund(jsonByteLength(earlier));
    }
    const kept = this.#deletedBytes.chargeEvicting(
      jsonByteLength(entity),
      () => {
        const oldest = this.#deleted.entries().next();
        if (oldest.done === true) return undefined;
        this.#deleted.delete(oldest.value[0]);
        return jsonByteLength(oldest.value[1]);
      },
    );
    if (kept) this.#deleted.set(key, entity);
  }

  /** Lazily cached set of entity IDs currently held in the store (invalidated on entity mutations). */
  entityIds(): ReadonlySet<string> {
    if (this.#entityIds === undefined) {
      const ids = new Set<string>();
      for (const entity of this.#content.entities) ids.add(entity.id);
      this.#entityIds = ids;
    }
    return this.#entityIds;
  }

  /** Set a held document's value, unless the state would outgrow what `data/add` loads; a value that is not the Evidence's cites no record. */
  setDocument(
    tool: string,
    value: JsonValue,
  ): Result<void, AnalysisResourceConstraintError> {
    const held = this.#documents.get(tool);
    if (held === undefined) return ok(undefined);
    const written = { tool: held.tool, path: held.path, value };
    const bytes = this.#grown(jsonByteLength(written) - jsonByteLength(held));
    if (!bytes.ok) return bytes;
    this.#documents.set(tool, written);
    this.#content = {
      ...this.#content,
      documents: this.#content.documents.map((document) =>
        document === held ? written : document,
      ),
    };
    this.#bytes = bytes.value;
    return ok(undefined);
  }

  /** The state's bytes after a change of `delta`, or a refusal when a change that grows it would pass the intake limit. */
  #grown(delta: number): Result<number, AnalysisResourceConstraintError> {
    const bytes = this.#bytes + delta;
    if (delta <= 0 || bytes <= STATE_INTAKE_LIMIT_BYTES) return ok(bytes);
    return err(
      new AnalysisResourceConstraintError(
        ENVIRONMENT_SERVE_OPERATION,
        "capacity",
        "The write would take the served state past the size data/add loads",
        { max_state_bytes: STATE_INTAKE_LIMIT_BYTES, state_bytes: bytes },
        {
          retryable: false,
          remediationAction:
            "Delete entities, or restore a smaller state with data/reset or data/add.",
        },
      ),
    );
  }

  type(collectionTemplate: string): StateType | undefined {
    return this.#types.get(collectionTemplate);
  }

  entity(
    type: string,
    collection: string,
    id: string,
  ): StateEntity | undefined {
    return this.#entities.get(environmentEntityKey(type, collection, id));
  }

  /** One collection's entities in state order. */
  inCollection(type: string, collection: string): readonly StateEntity[] {
    return (
      this.#collections.get(environmentCollectionKey(type, collection)) ?? []
    );
  }

  /** The collections holding entities of one type, in state order of their first entity. */
  collectionsOf(type: string): readonly string[] {
    return this.#typeCollections.get(type) ?? [];
  }

  /** Every collection spelling in the active, baseline, Evidence, or generated history, with active entities first. */
  knownCollectionsOf(type: string): readonly string[] {
    const known = new Set<string>();
    for (const collection of this.collectionsOf(type))
      if (this.#collections.has(environmentCollectionKey(type, collection)))
        known.add(collection);
    for (const collection of this.#knownCollections.get(type) ?? [])
      known.add(collection);
    return [...known];
  }

  document(tool: string): HeldDocument | undefined {
    return this.#documents.get(tool);
  }

  snapshot(): StateSnapshot {
    return snapshotOf(
      this.state,
      this.#content.entities,
      this.#content.documents,
    );
  }

  /** What `data/get` writes for the current state, in UTF-8 bytes. */
  byteLength(): number {
    return this.#bytes;
  }

  /** What `data/get` writes for some content, summed item by item so the whole state is never one string. */
  #contentBytes(content: StateContent): number {
    return (
      this.#frameBytes +
      itemsBytes(content.entities) +
      itemsBytes(content.documents)
    );
  }

  /** Build current-state indexes without copying baseline collections into generated history. */
  #install(content: StateContent, bytes: number): void {
    const entities = new Map<string, StateEntity>();
    const storedDeleted = new Map<string, StateEntity>();
    const collections = new Map<string, StateEntity[]>();
    const typeCollections = new Map<string, string[]>();
    const collectionEntityCounts = new Map<string, number>();
    const typeCollectionSets = new Map<string, Set<string>>();
    const recordTypeCollection = (type: string, collection: string): void => {
      let seen = typeCollectionSets.get(type);
      if (seen === undefined) {
        seen = new Set([collection]);
        typeCollectionSets.set(type, seen);
        typeCollections.set(type, [collection]);
        return;
      }
      if (!seen.has(collection)) {
        seen.add(collection);
        typeCollections.get(type)!.push(collection);
      }
    };
    for (const entity of content.entities) {
      const collKey = environmentCollectionKey(entity.type, entity.collection);
      collectionEntityCounts.set(
        collKey,
        (collectionEntityCounts.get(collKey) ?? 0) + 1,
      );
      if (markedDeleted(entity.fields)) {
        storedDeleted.set(
          environmentEntityKey(entity.type, entity.collection, entity.id),
          entity,
        );
        recordTypeCollection(entity.type, entity.collection);
        continue;
      }
      entities.set(
        environmentEntityKey(entity.type, entity.collection, entity.id),
        entity,
      );
      const members = collections.get(collKey);
      if (members !== undefined) {
        members.push(entity);
        continue;
      }
      collections.set(collKey, [entity]);
      recordTypeCollection(entity.type, entity.collection);
    }
    this.#entities = entities;
    this.#storedDeleted = storedDeleted;
    this.#collections = collections;
    this.#typeCollections = typeCollections;
    this.#collectionEntityCounts = collectionEntityCounts;
    this.#documents = new Map(
      content.documents.map((document) => [document.tool, document]),
    );
    this.#content = content;
    this.#entityIds = undefined;
    this.#bytes = bytes;
  }
}
