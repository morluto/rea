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
export const recoverIdentifierListSurvivors = (
  identities: readonly IdentifierListIdentity[],
  envIdentities: readonly EnvironmentListIdentity[],
  survivors: Map<number, number>,
  assigned: Set<number>,
): void => {
  const liveGroups = new Map<string, Group>();
  const liveByIndex = identities.map(({ literal, mapped }, index) =>
    groupOf(liveGroups, JSON.stringify([literal, mapped]), index),
  );
  const envGroups = new Map<string, Group>();
  const envByKey = new Map<string, Group[]>();
  const envByIndex = envIdentities.map((identity, index) => {
    const group = groupOf(envGroups, identity.literal, index);
    if (group.indices.length === 1)
      for (const key of identifierListKeys(identity)) {
        const candidates = envByKey.get(key);
        if (candidates === undefined) envByKey.set(key, [group]);
        else candidates.push(group);
      }
    return group;
  });
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
    liveByIndex[left]!.edges.find((edge) => edge.env === envByIndex[right])!;

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
