import {
  isAlias,
  isMap,
  isNode,
  isScalar,
  isSeq,
  parseDocument,
  visit,
  Document,
} from "yaml";
import type { Node } from "yaml";

/**
 * ggcode reads MCP servers from ~/.ggcode/mcp_servers.yaml, a top-level YAML
 * sequence of named entries: `- name: rea` with `type`, `command`, `args`,
 * `env`, `url`, and `headers` members. An empty `type` connects as stdio.
 *
 * ggcode auto-migrates a legacy `mcp_servers` section of the main ggcode.yaml
 * into that standalone file, and honors the section only while the file is
 * absent. This module accepts both layouts so setup can read the legacy layer
 * and seed a fresh standalone file with its entries instead of suppressing
 * them. REA writes only the standalone file; uninstall removes REA's legacy
 * in-main entry in place.
 */

// A comment-only document has no root; a bare marker has an unwritten null
// scalar. Explicit null values, tags and anchors remain actual values.
const isEmptyYamlRoot = (root: Document["contents"]): boolean =>
  root === null ||
  (isScalar(root) &&
    root.value === null &&
    root.source === "" &&
    root.tag === undefined &&
    root.anchor === undefined);

const parseGgcodeDocument = (text: string): Document => {
  const document = parseDocument(text);
  const error = document.errors[0];
  if (error !== undefined) throw error;
  return document;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// Reads resolve YAML aliases through toJS(), so an anchored `name: *anchor`
// entry addresses the server the reader sees; the editors must match the
// same resolved value or setup would append a duplicate and uninstall would
// miss the entry entirely.
const entryName = (item: unknown, document: Document): unknown => {
  if (!isMap(item)) return undefined;
  const name = item.get("name");
  return isAlias(name) ? name.toJS(document) : name;
};

/** Named entries of one mcp_servers sequence; malformed items fail closed. */
const sequenceEntries = (
  items: readonly unknown[],
  description: string,
): Record<string, unknown> => {
  const entries = new Map<string, unknown>();
  for (const item of items) {
    if (!isPlainObject(item))
      throw new TypeError(`${description} entries must be named mappings`);
    const { name, ...entry } = item;
    // ggcode loads an unnamed entry, but no registration can address it by
    // name, so it stays written yet outside REA's server table.
    if (typeof name !== "string" || name === "") continue;
    // A read keeps the last duplicate while an edit replaces the first;
    // reject duplicate names so every path agrees on the addressed entry.
    if (entries.has(name))
      throw new TypeError(
        `${description} holds duplicate server name ${JSON.stringify(name)}`,
      );
    entries.set(name, entry);
  }
  // Object.fromEntries keeps a `__proto__` server name as own data instead
  // of assigning it to the prototype.
  return Object.fromEntries(entries);
};

/** Legacy mapping form `mcp_servers: {name: entry}`; the key names the entry. */
const mappingEntries = (
  value: Record<string, unknown>,
  description: string,
): Record<string, unknown> => {
  const entries = new Map<string, unknown>();
  for (const [name, entry] of Object.entries(value)) {
    if (!isPlainObject(entry))
      throw new TypeError(`${description} entries must be mappings`);
    const { name: innerName, ...rest } = entry;
    void innerName;
    entries.set(name, rest);
  }
  return Object.fromEntries(entries);
};

const serverEntries = (
  value: unknown,
  description: string,
): Record<string, unknown> => {
  if (Array.isArray(value)) return sequenceEntries(value, description);
  if (isPlainObject(value)) return mappingEntries(value, description);
  throw new TypeError(
    `${description} must be a sequence of named server mappings`,
  );
};

/**
 * Parse one ggcode layout into the synthetic `mcp_servers` server table. The
 * standalone mcp_servers.yaml is a top-level sequence; a mapping root is only
 * the legacy in-main ggcode.yaml layout, which ggcode cannot load as the
 * standalone file, so standalone reads reject it instead of reporting the
 * unreadable registration as healthy.
 */
export const parseGgcodeConfigurationYaml = (
  text: string,
  layout: "standalone" | "legacy" = "standalone",
): Record<string, unknown> => {
  const document = parseGgcodeDocument(text);
  if (isEmptyYamlRoot(document.contents)) return {};
  const value: unknown = document.toJS();
  if (Array.isArray(value))
    return { mcp_servers: sequenceEntries(value, "The configuration root") };
  if (isPlainObject(value)) {
    if (layout === "standalone")
      throw new TypeError(
        "The configuration root must be a sequence of named server mappings; a mapping root is only valid as the legacy ggcode.yaml layout",
      );
    const section = value.mcp_servers;
    return section === undefined
      ? {}
      : { mcp_servers: serverEntries(section, '"mcp_servers"') };
  }
  throw new TypeError(
    "The configuration root must be a sequence of named server mappings or a mapping holding mcp_servers",
  );
};

/**
 * Whether either ggcode layout holds sequence entries no `name` addresses.
 * ggcode loads them, but setup cannot migrate an unnamed entry into the keyed
 * standalone table without dropping it, so migration refuses such a file.
 */
export const ggcodeConfigurationHasUnnamedServers = (text: string): boolean => {
  // Resolve `name: *anchor` through the same boundary the editors use: an
  // aliased name still addresses its server, so it is not an unnamed entry.
  const hasUnnamed = (node: unknown, document: Document): boolean =>
    isSeq(node) &&
    node.items.some((item) => {
      if (!isMap(item)) return false;
      const name = entryName(item, document);
      return typeof name !== "string" || name === "";
    });
  const document = parseGgcodeDocument(text);
  const root = document.contents;
  if (isSeq(root)) return hasUnnamed(root, document);
  if (isMap(root)) return hasUnnamed(root.get("mcp_servers", true), document);
  return false;
};

/** Copy original bindings so replaced aliases cannot bind to later anchors. */
const copyGgcodeAliasSource = (
  source: unknown,
  document: Document,
  visiting = new Set<Node>(),
): unknown => {
  const node = isAlias(source) ? source.resolve(document) : source;
  if (isAlias(source) && node === undefined)
    throw new TypeError("Cannot edit an unresolved ggcode YAML alias");
  if (!isNode(node)) return node;
  if (visiting.has(node))
    throw new TypeError("Cannot edit cyclic ggcode YAML aliases");
  visiting.add(node);
  const copied = node.clone();
  if (isScalar(copied) || isMap(copied) || isSeq(copied)) delete copied.anchor;
  if (isSeq(node) && isSeq(copied))
    copied.items = node.items.map((item) =>
      copyGgcodeAliasSource(item, document, visiting),
    );
  else if (isMap(node) && isMap(copied))
    copied.items.forEach((pair, index) => {
      const original = node.items[index];
      if (original === undefined) return;
      pair.key = copyGgcodeAliasSource(original.key, document, visiting);
      pair.value = copyGgcodeAliasSource(original.value, document, visiting);
    });
  if (isAlias(source)) {
    delete copied.commentBefore;
    delete copied.comment;
    if (source.commentBefore !== undefined)
      copied.commentBefore = source.commentBefore;
    if (source.comment !== undefined) copied.comment = source.comment;
  }
  visiting.delete(node);
  return copied;
};

/** Outside aliases keep their original bindings when the rea entry changes. */
const retainGgcodeAliasConsumers = (
  document: Document,
  previous: unknown,
): void => {
  if (!isNode(previous)) return;
  const replaced = new Set<Node>();
  visit(previous, {
    Node: (_key, node) => {
      replaced.add(node);
    },
  });
  visit(document, {
    Alias: (_key, alias, path) => {
      const source = alias.resolve(document);
      if (
        source === undefined ||
        !replaced.has(source) ||
        path.some((parent) => isNode(parent) && replaced.has(parent))
      )
        return;
      const copied = copyGgcodeAliasSource(alias, document);
      return isNode(copied) ? copied : undefined;
    },
  });
};

/**
 * Set or delete one named entry in a standalone mcp_servers.yaml, keeping the
 * rest of the document as written. A mapping root is the legacy ggcode.yaml
 * layout, which accepts only deletion so uninstall can drop REA's in-main
 * entry in place; upserts into it stay rejected.
 */
export const editGgcodeConfigurationYaml = (
  text: string,
  serverKey: string,
  entry: unknown,
): string => {
  const document = parseGgcodeDocument(text);
  let root = document.contents;
  if (isEmptyYamlRoot(root)) {
    const sequence = document.createNode([]);
    if (isScalar(root))
      sequence.commentBefore = [root.commentBefore, root.comment]
        .filter((comment) => comment !== undefined)
        .join("\n");
    document.contents = sequence;
    root = sequence;
  }
  if (isMap(root)) {
    // The legacy in-main ggcode.yaml layout: setup never writes this file,
    // but uninstall removes REA's entry from its mcp_servers section in place.
    if (entry !== undefined)
      throw new TypeError(
        "The configuration root must be a sequence of named server mappings",
      );
    const section = root.get("mcp_servers", true);
    if (isSeq(section)) {
      const index = section.items.findIndex(
        (item) => entryName(item, document) === serverKey,
      );
      if (index >= 0) {
        retainGgcodeAliasConsumers(document, section.items[index]);
        section.items.splice(index, 1);
      }
    } else if (isMap(section)) {
      section.delete(serverKey);
    }
    return document.toString({ lineWidth: 0 });
  }
  if (!isSeq(root))
    throw new TypeError(
      "The configuration root must be a sequence of named server mappings",
    );
  const index = root.items.findIndex(
    (item) => entryName(item, document) === serverKey,
  );
  if (entry === undefined) {
    if (index >= 0) {
      retainGgcodeAliasConsumers(document, root.items[index]);
      root.items.splice(index, 1);
    }
  } else {
    const node = document.createNode({
      name: serverKey,
      ...(isPlainObject(entry) ? entry : {}),
    });
    if (index < 0) {
      root.items.push(node);
    } else {
      const previous = root.items[index];
      retainGgcodeAliasConsumers(document, previous);
      if (isNode(previous)) {
        const commentBefore = previous.commentBefore ?? node.commentBefore;
        if (commentBefore !== undefined) node.commentBefore = commentBefore;
        const comment = previous.comment ?? node.comment;
        if (comment !== undefined) node.comment = comment;
      }
      root.items[index] = node;
    }
  }
  // Editing REA must not reflow unrelated user entries or other YAML scalars.
  return document.toString({ lineWidth: 0 });
};

/** Create a standalone mcp_servers.yaml from the synthetic server table. */
export const stringifyGgcodeConfigurationYaml = (
  document: Record<string, unknown>,
): string => {
  const servers = document.mcp_servers;
  const entries = isPlainObject(servers)
    ? Object.entries(servers).map(([name, entry]) => ({
        name,
        ...(isPlainObject(entry) ? entry : {}),
      }))
    : [];
  return new Document(entries).toString({ lineWidth: 0 });
};
