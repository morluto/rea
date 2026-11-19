/** The two keys are different namespaces: literal equality is typed, learned equality is textual. */
export interface IdentifierListIdentity {
  readonly literal: string | undefined;
  readonly mapped: string | undefined;
}

export type EnvironmentListIdentity = IdentifierListIdentity & {
  readonly literal: string;
};

export const identifierListKeys = ({
  literal,
  mapped,
}: IdentifierListIdentity): string[] =>
  [literal, mapped].filter((key) => key !== undefined);

type Buckets = ReadonlyMap<string, { readonly indices: readonly number[] }>;

/** Attain the maximum possible matches when literals and mapped-only matches suffice. */
export const completePairingByLiteral = (
  identities: readonly IdentifierListIdentity[],
  available: Buckets,
  survivors: ReadonlyMap<number, number>,
  liveIndices: Iterable<number>,
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
  for (const left of liveIndices) {
    const key = identities[left]!.literal;
    if (key === undefined || literal.has(left)) continue;
    const candidates = available.get(key)?.indices ?? [];
    let index = next.get(key) ?? 0;
    while (index < candidates.length && occupied.has(candidates[index]!))
      index++;
    const right = candidates[index];
    next.set(key, right === undefined ? index : index + 1);
    if (right === undefined) continue;
    literal.set(left, right);
    if (literal.size === limit) return literal;
  }
  return undefined;
};

interface Component {
  readonly live: number[];
  readonly env: number[];
}

/** Only components containing a free entry on each side can add matches. */
const conflictComponents = (
  identities: readonly IdentifierListIdentity[],
  envIdentities: readonly EnvironmentListIdentity[],
  available: Buckets,
  survivors: ReadonlyMap<number, number>,
  assigned: ReadonlySet<number>,
): Iterable<Component> => {
  const parent = Int32Array.from(envIdentities, (_, index) => index);
  const rank = new Uint8Array(envIdentities.length);
  const find = (index: number): number => {
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]!]!;
      index = parent[index]!;
    }
    return index;
  };
  const join = (one: number, two: number): void => {
    const a = find(one);
    const b = find(two);
    if (a === b) return;
    if (rank[a]! < rank[b]!) parent[a] = b;
    else {
      parent[b] = a;
      if (rank[a] === rank[b]) rank[a] = rank[a]! + 1;
    }
  };
  const first = (key: string | undefined): number | undefined =>
    key === undefined ? undefined : available.get(key)?.indices[0];
  // Each key represents an entire bucket of equivalent environment items.
  for (const [index, { literal, mapped }] of envIdentities.entries())
    join(index, first(mapped ?? literal)!);
  const liveAnchor = identities.map(({ literal, mapped }) => {
    const raw = first(literal);
    const learned = first(mapped);
    if (raw !== undefined && learned !== undefined) join(raw, learned);
    return raw ?? learned;
  });
  const freeEnv = new Set<number>();
  for (const index of envIdentities.keys())
    if (!assigned.has(index)) freeEnv.add(find(index));
  const components = new Map<number, Component>();
  for (const [index, anchor] of liveAnchor.entries()) {
    if (anchor === undefined || survivors.has(index)) continue;
    const root = find(anchor);
    if (freeEnv.has(root) && !components.has(root))
      components.set(root, { live: [], env: [] });
  }
  for (const [index, anchor] of liveAnchor.entries())
    if (anchor !== undefined) components.get(find(anchor))?.live.push(index);
  for (const index of envIdentities.keys())
    components.get(find(index))?.env.push(index);
  return components.values();
};

interface Group {
  readonly indices: number[];
  readonly edges: Edge[];
  free: number;
  cursor: number;
}

interface Edge {
  readonly live: Group;
  readonly env: Group;
  used: number;
}

const groupOf = (
  groups: Map<string, Group>,
  key: string,
  index: number,
): Group => {
  let group = groups.get(key);
  if (group === undefined) {
    group = { indices: [], edges: [], free: 0, cursor: 0 };
    groups.set(key, group);
  }
  group.indices.push(index);
  group.free++;
  return group;
};

/** Find a path that moves existing matches to leave space for more survivors. */
const fill = (start: Group, blocked: Set<Group>): boolean => {
  const pending = [start];
  const from = new Map<Group, Edge>();
  const fromEnv = new Map<Group, Edge>();
  let end: Edge | undefined;
  for (const live of pending) {
    for (const edge of live.edges) {
      const env = edge.env;
      if (fromEnv.has(env)) continue;
      fromEnv.set(env, edge);
      if (env.free > 0) {
        end = edge;
        break;
      }
      for (const previous of env.edges) {
        const source = previous.live;
        if (
          previous.used === 0 ||
          source === start ||
          from.has(source) ||
          blocked.has(source)
        )
          continue;
        from.set(source, previous);
        pending.push(source);
      }
    }
    if (end !== undefined) break;
  }
  if (end === undefined) {
    for (const group of pending) blocked.add(group);
    return false;
  }

  const path: { readonly add: Edge; readonly remove: Edge | undefined }[] = [];
  let amount = Math.min(start.free, end.env.free);
  for (let add: Edge | undefined = end; add !== undefined;) {
    const remove = from.get(add.live);
    path.push({ add, remove });
    if (remove !== undefined) amount = Math.min(amount, remove.used);
    add = remove === undefined ? undefined : fromEnv.get(remove.env)!;
  }
  start.free -= amount;
  end.env.free -= amount;
  for (const { add, remove } of path) {
    add.used += amount;
    if (remove !== undefined) remove.used -= amount;
  }
  blocked.clear();
  return true;
};

/** Maximize the survivor count with one capacity per distinct identity, then assign original positions. */
const fillComponent = (
  component: Component,
  identities: readonly IdentifierListIdentity[],
  envIdentities: readonly EnvironmentListIdentity[],
  survivors: Map<number, number>,
  assigned: Set<number>,
): void => {
  const liveGroups = new Map<string, Group>();
  const liveByIndex = new Map<number, Group>();
  for (const index of component.live) {
    const { literal, mapped } = identities[index]!;
    liveByIndex.set(
      index,
      groupOf(liveGroups, JSON.stringify([literal, mapped]), index),
    );
  }
  const envGroups = new Map<string, Group>();
  const envByKey = new Map<string, Group[]>();
  const envByIndex = new Map<number, Group>();
  for (const index of component.env) {
    const identity = envIdentities[index]!;
    const group = groupOf(envGroups, identity.literal, index);
    envByIndex.set(index, group);
    if (group.indices.length === 1)
      for (const key of identifierListKeys(identity)) {
        const candidates = envByKey.get(key);
        if (candidates === undefined) envByKey.set(key, [group]);
        else candidates.push(group);
      }
  }
  for (const live of liveGroups.values()) {
    const identity = identities[live.indices[0]!]!;
    const candidates = new Set(
      identifierListKeys(identity).flatMap((key) => envByKey.get(key) ?? []),
    );
    for (const env of candidates) {
      const edge = { live, env, used: 0 };
      live.edges.push(edge);
      env.edges.push(edge);
    }
  }
  const matchEdge = (left: number, right: number): Edge =>
    liveByIndex
      .get(left)!
      .edges.find((edge) => edge.env === envByIndex.get(right))!;

  for (const [left, right] of survivors) {
    const edge = matchEdge(left, right);
    edge.used++;
    edge.live.free--;
    edge.env.free--;
  }
  const blocked = new Set<Group>();
  let changed = false;
  for (const group of liveGroups.values())
    while (group.free > 0 && !blocked.has(group) && fill(group, blocked))
      changed = true;
  if (!changed) return;

  // Keep the original matches where the final capacities still permit them.
  for (const [left, right] of survivors) {
    const edge = matchEdge(left, right);
    if (edge.used > 0) edge.used--;
    else {
      survivors.delete(left);
      assigned.delete(right);
    }
  }
  for (const live of liveGroups.values())
    for (const { env, used } of live.edges)
      for (let index = 0; index < used; index++) {
        while (survivors.has(live.indices[live.cursor]!)) live.cursor++;
        while (assigned.has(env.indices[env.cursor]!)) env.cursor++;
        const left = live.indices[live.cursor++]!;
        const right = env.indices[env.cursor++]!;
        survivors.set(left, right);
        assigned.add(right);
      }
};

export const recoverIdentifierListSurvivors = (
  identities: readonly IdentifierListIdentity[],
  envIdentities: readonly EnvironmentListIdentity[],
  available: Buckets,
  survivors: Map<number, number>,
  assigned: Set<number>,
): void => {
  for (const component of conflictComponents(
    identities,
    envIdentities,
    available,
    survivors,
    assigned,
  )) {
    const local = new Map<number, number>();
    for (const left of component.live) {
      const right = survivors.get(left);
      if (right !== undefined) local.set(left, right);
    }
    const limit = Math.min(component.live.length, component.env.length);
    const literal = completePairingByLiteral(
      identities,
      available,
      local,
      component.live,
      limit,
    );
    const recovered = literal ?? local;
    if (literal === undefined)
      fillComponent(
        component,
        identities,
        envIdentities,
        recovered,
        new Set(local.values()),
      );
    for (const left of component.live) {
      const right = survivors.get(left);
      if (right === undefined) continue;
      survivors.delete(left);
      assigned.delete(right);
    }
    for (const [left, right] of recovered) {
      survivors.set(left, right);
      assigned.add(right);
    }
  }
};
