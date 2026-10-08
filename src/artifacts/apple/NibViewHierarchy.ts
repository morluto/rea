import type { NibArchiveDocument } from "./NibArchive.js";
import type { JsonValue } from "../../domain/jsonValue.js";

export type NibHierarchyNode = {
  objectID: string;
  children: NibHierarchyNode[];
};

/** Project encoded view parents; archive owners are not inferred view parents. */
export const projectNibViewHierarchy = (
  objects: NibArchiveDocument["objects"],
  retainedIds: ReadonlySet<number>,
  reserveNode: () => boolean = () => true,
  maxNodes = 20_000,
) => {
  const { parents, involved, invalid } = collectNibParents(
    objects,
    retainedIds,
  );
  if (parents.size === 0) return { hierarchy: null, omitted: invalid };
  const children = new Map<number, number[]>();
  for (const [child, parent] of parents) {
    if (!retainedIds.has(parent) || !retainedIds.has(child)) continue;
    const siblings = children.get(parent) ?? [];
    siblings.push(child);
    children.set(parent, siblings);
  }
  const roots: NibHierarchyNode[] = [];
  const pending: { id: number; depth: number; output: NibHierarchyNode[] }[] =
    [];
  for (const id of involved)
    if (!parents.has(id)) pending.push({ id, depth: 0, output: roots });
  const visited = new Set<number>();
  while (pending.length > 0) {
    const item = pending.pop();
    if (item === undefined) break;
    if (
      visited.has(item.id) ||
      item.depth > 128 ||
      visited.size >= maxNodes ||
      !reserveNode()
    )
      continue;
    visited.add(item.id);
    const node: NibHierarchyNode = { objectID: String(item.id), children: [] };
    item.output.push(node);
    for (const child of [...(children.get(item.id) ?? [])].reverse())
      pending.push({ id: child, depth: item.depth + 1, output: node.children });
  }
  return {
    hierarchy: roots,
    omitted: involved.size - visited.size + invalid,
  };
};

/** Add encoded parent links once; conflicting legacy parents remain unknown. */
export const mergeNibHierarchies = (
  legacy: NibHierarchyNode[],
  recovered: NibHierarchyNode[],
  reserveNode: () => boolean = () => true,
  maxNodes = 20_000,
) => {
  const existing = new Map<string, NibHierarchyNode>();
  const owners = new Map<string, NibHierarchyNode[]>();
  const parents = new Map<string, string>();
  const pending = legacy.map((node) => ({
    node,
    output: legacy,
    parent: null as string | null,
  }));
  while (pending.length > 0) {
    const entry = pending.pop();
    if (entry === undefined || existing.has(entry.node.objectID)) continue;
    existing.set(entry.node.objectID, entry.node);
    owners.set(entry.node.objectID, entry.output);
    if (entry.parent !== null) parents.set(entry.node.objectID, entry.parent);
    pending.push(
      ...entry.node.children.map((node) => ({
        node,
        output: entry.node.children,
        parent: entry.node.objectID,
      })),
    );
  }
  let omitted = 0;
  const additions = recovered.map((node) => ({
    node,
    output: legacy,
    parent: null as string | null,
  }));
  while (additions.length > 0) {
    const entry = additions.pop();
    if (entry === undefined) break;
    let target = existing.get(entry.node.objectID);
    if (target === undefined) {
      if (existing.size >= maxNodes || !reserveNode()) {
        omitted += 1;
        continue;
      }
      target = { objectID: entry.node.objectID, children: [] };
      existing.set(target.objectID, target);
      entry.output.push(target);
      owners.set(target.objectID, entry.output);
      if (entry.parent !== null) parents.set(target.objectID, entry.parent);
    } else if (
      entry.parent !== null &&
      owners.get(target.objectID) !== entry.output
    ) {
      const owner = owners.get(target.objectID);
      if (
        owner !== legacy ||
        wouldCycle(target.objectID, entry.parent, parents)
      ) {
        omitted += 1;
      } else {
        owner.splice(owner.indexOf(target), 1);
        entry.output.push(target);
        owners.set(target.objectID, entry.output);
        parents.set(target.objectID, entry.parent);
      }
    }
    for (const node of [...entry.node.children].reverse())
      additions.push({
        node,
        output: target.children,
        parent: target.objectID,
      });
  }
  return { hierarchy: legacy, omitted };
};

const wouldCycle = (
  child: string,
  parent: string,
  parents: ReadonlyMap<string, string>,
): boolean => {
  const seen = new Set<string>();
  let current: string | undefined = parent;
  while (current !== undefined && !seen.has(current)) {
    if (current === child) return true;
    seen.add(current);
    current = parents.get(current);
  }
  return false;
};

const reference = (value: JsonValue | undefined): number | null => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return typeof value.$nib_object_ref === "number"
    ? value.$nib_object_ref
    : null;
};

const collectNibParents = (
  objects: NibArchiveDocument["objects"],
  retainedIds: ReadonlySet<number>,
) => {
  const parents = new Map<number, number>();
  const involved = new Set<number>();
  let invalid = 0;
  for (const object of objects) {
    if (!retainedIds.has(object.id)) continue;
    const child = reference(object.values.NSWindowView);
    if (
      object.class_name.replace(/\0+$/u, "") === "NSWindowTemplate" &&
      invalidReference(object.values.NSWindowView)
    )
      invalid += 1;
    if (
      object.class_name.replace(/\0+$/u, "") === "NSWindowTemplate" &&
      child !== null
    ) {
      parents.set(child, object.id);
      involved.add(object.id);
      involved.add(child);
    }
    const parent = reference(object.values.NSSuperview);
    if (invalidReference(object.values.NSSuperview)) invalid += 1;
    if (parent === null) continue;
    parents.set(object.id, parent);
    involved.add(object.id);
    if (retainedIds.has(parent)) involved.add(parent);
  }
  return { parents, involved, invalid };
};

const invalidReference = (value: JsonValue | undefined): boolean =>
  value !== undefined && value !== null && reference(value) === null;
