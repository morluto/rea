import type { PriResources } from "../../domain/native/priResources.js";
import {
  cooperate,
  priFailure,
  readPriLayout,
  type PriLayout,
  type PriSection,
} from "./PriLayout.js";
import { readResourceMap, type PriResourceMap } from "./PriResourceMap.js";
import { readSchema, type PriSchema } from "./PriSchema.js";
import {
  readDataItems,
  readDecisionInfo,
  readDescriptor,
  type PriDataItems,
  type PriDecisionInfo,
  type PriDescriptor,
} from "./PriSections.js";
import { TextBudget } from "./PriText.js";

/** Every section the descriptor and its resource maps reference, decoded and checked. */
export interface PriFile {
  readonly bytes: Buffer;
  readonly layout: PriLayout;
  readonly descriptor: PriDescriptor;
  readonly maps: readonly PriResourceMap[];
  /** Decoded decision info sections in section order. */
  readonly decisionInfos: readonly PriDecisionInfo[];
  /** Sections whose content REA decoded. */
  readonly interpreted: ReadonlySet<number>;
}

/** Decodes each referenced section once, after checking its declared role. */
class SectionCache {
  readonly #sections: readonly PriSection[];
  readonly #magic: PriResources["header"]["magic"];
  readonly #budget = new TextBudget();
  readonly #schemas = new Map<number, PriSchema>();
  readonly #decisionInfos = new Map<number, PriDecisionInfo>();
  readonly #dataItems = new Map<number, PriDataItems>();
  readonly interpreted = new Set<number>();

  constructor(layout: PriLayout) {
    this.#sections = layout.sections;
    this.#magic = layout.header.magic;
  }

  section(index: number, kind: PriSection["kind"], role: string): PriSection {
    const section = this.#sections[index];
    if (section?.kind !== kind)
      return priFailure(
        `PRI ${role} reference ${String(index)} is not a ${kind} section.`,
      );
    this.interpreted.add(index);
    return section;
  }

  schema(index: number): PriSchema {
    let schema = this.#schemas.get(index);
    if (schema === undefined) {
      schema = readSchema(
        this.section(index, "hierarchical-schema", "schema"),
        this.#budget,
      );
      this.#schemas.set(index, schema);
    }
    return schema;
  }

  decisionInfo(index: number): PriDecisionInfo {
    let decisionInfo = this.#decisionInfos.get(index);
    if (decisionInfo === undefined) {
      decisionInfo = readDecisionInfo(
        this.section(index, "decision-info", "decision info"),
        this.#magic,
        this.#budget,
      );
      this.#decisionInfos.set(index, decisionInfo);
    }
    return decisionInfo;
  }

  dataItems(index: number): PriDataItems {
    let dataItems = this.#dataItems.get(index);
    if (dataItems === undefined) {
      dataItems = readDataItems(this.section(index, "data-items", "data item"));
      this.#dataItems.set(index, dataItems);
    }
    return dataItems;
  }

  decisionInfos(): readonly PriDecisionInfo[] {
    return [...this.#decisionInfos.values()].sort(
      (left, right) => left.section - right.section,
    );
  }
}

/** Validate the container, then decode every section the descriptor lists. */
export const decodePriFile = async (
  bytes: Buffer,
  signal?: AbortSignal,
): Promise<PriFile> => {
  const layout = readPriLayout(bytes);
  const descriptor = readDescriptor(layout.sections);
  const cache = new SectionCache(layout);
  cache.interpreted.add(descriptor.section);
  for (const index of descriptor.decisionInfos) cache.decisionInfo(index);
  for (const index of descriptor.schemas) cache.schema(index);
  // Each data item table holds at most 131,070 entries; yield between tables.
  for (const [position, index] of descriptor.dataItems.entries()) {
    await cooperate(position, signal, 16);
    cache.dataItems(index);
  }
  const maps: PriResourceMap[] = [];
  for (const index of descriptor.resourceMaps)
    maps.push(
      await readResourceMap(
        cache.section(index, "resource-map", "resource map"),
        cache,
        signal,
      ),
    );
  return {
    bytes,
    layout,
    descriptor,
    maps,
    decisionInfos: cache.decisionInfos(),
    interpreted: cache.interpreted,
  };
};
