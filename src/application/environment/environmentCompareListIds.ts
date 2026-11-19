import type { JsonValue } from "../../domain/jsonValue.js";
import type { IdMap } from "./environmentCompareIds.js";
import {
  identifierListKeys as keysOf,
  recoverIdentifierListSurvivors,
  type EnvironmentListIdentity,
  type IdentifierListIdentity as Identity,
} from "./environmentIdentifierListSurvivors.js";

const ID_LIST_FIELD = /^(ids|uuids|guids)$/u;
const scalar = (value: JsonValue): boolean =>
  value === null || typeof value !== "object";
const literalKey = (value: JsonValue): string =>
  `literal:${JSON.stringify(value)}`;
const identityKey = (value: string | number): string => `id:${value}`;

const environmentIdentity = (value: JsonValue): EnvironmentListIdentity => ({
  literal: literalKey(value),
  mapped:
    typeof value === "number" || typeof value === "string"
      ? identityKey(value)
      : undefined,
});

/** Try the absolute upper bound by retaining mapped-only matches and filling the rest by literal equality. */
const completePairingByLiteral = (
  identities: readonly Identity[],
  available: ReadonlyMap<string, { readonly indices: number[] }>,
  survivors: ReadonlyMap<number, number>,
  limit: number,
): Map<number, number> | undefined => {
  const literal = new Map<number, number>();
  const occupied = new Set<number>();
  for (const [left, right] of survivors) {
    const key = identities[left]!.literal;
    if (key !== undefined && available.has(key)) continue;
    literal.set(left, right);
    occupied.add(right);
  }
  const next = new Map<string, number>();
  for (const [left, identity] of identities.entries()) {
    const key = identity.literal;
    if (key === undefined || literal.has(left)) continue;
    const candidates = available.get(key)?.indices ?? [];
    let index = next.get(key) ?? 0;
    while (index < candidates.length && occupied.has(candidates[index]!))
      index++;
    const right = candidates[index];
    if (right === undefined) continue;
    literal.set(left, right);
    if (literal.size === limit) return literal;
    next.set(key, index + 1);
  }
  return undefined;
};

/** Compare one scalar identifier list using the call's proven collection ownership. */
export const compareIdentifierList = (
  live: readonly JsonValue[],
  env: readonly JsonValue[],
  field: string | undefined,
  map: IdMap,
  ownedScope: string | undefined,
):
  | {
      readonly survivors: ReadonlyMap<number, number>;
      readonly replacements: ReadonlyMap<number, number>;
      readonly hasMapping: ReadonlySet<number>;
      readonly reordered: boolean;
    }
  | undefined => {
  if (field === undefined) return undefined;
  const named = ID_LIST_FIELD.test(field);
  if (
    (!named &&
      !live.some(
        (value) =>
          typeof value === "string" && map.isStateReference(value, field),
      )) ||
    !live.every(scalar) ||
    !env.every(scalar)
  )
    return undefined;
  const scope = named ? ownedScope : undefined;
  const hasMapping = new Set<number>();
  const identities = live.map((value, index): Identity => {
    const id =
      ((typeof value === "number" || typeof value === "string") && named) ||
      (typeof value === "string" && map.isStateReference(value, field));
    const mapped = id ? map.env(value, scope) : undefined;
    if (mapped !== undefined) hasMapping.add(index);
    return {
      literal:
        scope !== undefined &&
        mapped !== undefined &&
        String(mapped) !== String(value)
          ? undefined
          : literalKey(value),
      mapped: mapped === undefined ? undefined : identityKey(mapped),
    };
  });
  if (!named && hasMapping.size === 0) return undefined;

  let survivors = new Map<number, number>();
  let assigned = new Set<number>();
  const envIdentities = env.map(environmentIdentity);
  // Preserve complete lists that already agree in position, including
  // literal references whose collection was not established.
  if (
    live.length === env.length &&
    identities.every(
      ({ literal, mapped }, index) =>
        (literal !== undefined && literal === envIdentities[index]!.literal) ||
        (mapped !== undefined && mapped === envIdentities[index]!.mapped),
    )
  ) {
    for (const index of live.keys()) survivors.set(index, index);
    return { survivors, replacements: new Map(), hasMapping, reordered: false };
  }

  const available = new Map<string, { indices: number[]; next: number }>();
  for (const [index, identity] of envIdentities.entries())
    for (const key of keysOf(identity)) {
      const bucket = available.get(key);
      if (bucket === undefined)
        available.set(key, { indices: [index], next: 0 });
      else bucket.indices.push(index);
    }

  const pair = (left: number, key: string | undefined): void => {
    if (key === undefined || survivors.has(left)) return;
    const bucket = available.get(key);
    if (bucket === undefined) return;
    while (bucket.next < bucket.indices.length) {
      const right = bucket.indices[bucket.next++]!;
      if (assigned.has(right)) continue;
      survivors.set(left, right);
      assigned.add(right);
      return;
    }
  };
  // Protect values that have only a literal match before taking optional
  // raw matches for mapped references with unresolved collection ownership.
  for (const [index, { mapped, literal }] of identities.entries())
    if (mapped === undefined) pair(index, literal);
  for (const [index, { mapped }] of identities.entries()) pair(index, mapped);
  for (const [index, { literal }] of identities.entries()) pair(index, literal);

  const upperBound = Math.min(live.length, env.length);
  if (
    survivors.size < upperBound &&
    identities.some(
      (identity, index) =>
        !survivors.has(index) &&
        keysOf(identity).some((key) => available.has(key)),
    )
  ) {
    const literal = completePairingByLiteral(
      identities,
      available,
      survivors,
      upperBound,
    );
    if (literal === undefined)
      recoverIdentifierListSurvivors(
        identities,
        envIdentities,
        survivors,
        assigned,
      );
    else {
      survivors = literal;
      assigned = new Set(literal.values());
    }
  }

  const occurrences = new Map<string, number>();
  for (const identity of identities)
    for (const key of keysOf(identity))
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
  const replacements = new Map<number, number>();
  let replacement = 0;
  let last = -1;
  let reordered = false;
  for (const [index, identity] of identities.entries()) {
    const right = survivors.get(index);
    if (right === undefined) {
      while (assigned.has(replacement)) replacement++;
      if (replacement < env.length) replacements.set(index, replacement++);
      continue;
    }
    // A duplicate or overlapping literal/mapped choice cannot establish
    // the relative position of that occurrence.
    if (
      keysOf(identity).some((key) =>
        available.get(key)?.indices.some((candidate) => candidate !== right),
      ) ||
      keysOf(envIdentities[right]!).some(
        (key) =>
          (occurrences.get(key) ?? 0) >
          Number(key === identity.literal || key === identity.mapped),
      )
    )
      continue;
    reordered ||= right < last;
    last = right;
  }
  return { survivors, replacements, hasMapping, reordered };
};
