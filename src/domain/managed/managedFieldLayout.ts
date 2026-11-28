import { z } from "zod";
import type { ManagedMemberInspection } from "./managedArtifact.js";

/** Comparable declarations only: zero retains the platform-default/unspecified meaning. */
export const managedFieldLayoutSchema = z.strictObject({
  state: z.enum(["known", "unknown"]),
  kind: z.enum(["auto", "sequential", "explicit"]).nullable(),
  packing_size: z.int().min(0).max(128).nullable(),
  class_size: z.int().min(0).max(0xffff_ffff).nullable(),
  field_offset: z.int().min(0).max(0xffff_ffff).nullable(),
});

export type ManagedFieldLayout = z.infer<typeof managedFieldLayoutSchema>;
type Field = ManagedMemberInspection["fields"][number];
type Inventory = NonNullable<ManagedMemberInspection["layout_declarations"]>;

const UNKNOWN: ManagedFieldLayout = Object.freeze({
  state: "unknown",
  kind: null,
  packing_size: null,
  class_size: null,
  field_offset: null,
});
const STATIC: ManagedFieldLayout = Object.freeze({
  ...UNKNOWN,
  state: "known",
});

const groupsBy = <T>(rows: readonly T[], key: (row: T) => string | null) => {
  const result = new Map<string, T[]>();
  for (const row of rows) {
    const identity = key(row);
    if (identity === null) continue;
    const previous = result.get(identity);
    if (previous === undefined) result.set(identity, [row]);
    else previous.push(row);
  }
  return result;
};

/** Index one immutable source inventory once for all compared fields. */
export const managedFieldLayoutReader = (
  report: ManagedMemberInspection,
): ((field: Field) => ManagedFieldLayout) => {
  const inventory = report.layout_declarations;
  if (inventory == null || inventory.state !== "complete") return () => UNKNOWN;
  const types = groupsBy(report.types, (row) => row.token);
  const classes = groupsBy(inventory.classes, (row) => row.type_token);
  const fields = groupsBy(inventory.fields, (row) => row.field_token);
  return (field) => {
    const offsets = fields.get(field.token) ?? [];
    if ((field.flags & 0x10) !== 0)
      return offsets.length === 0 ? STATIC : UNKNOWN;
    if (field.declaring_type_token === null) return UNKNOWN;
    const owners = types.get(field.declaring_type_token);
    const owner = owners?.[0];
    if (
      owners?.length !== 1 ||
      owner === undefined ||
      (owner.flags & 0x20) !== 0
    )
      return UNKNOWN;
    return declaredLayout(
      owner.flags & 0x18,
      classes.get(owner.token) ?? [],
      offsets,
      owner.token,
    );
  };
};

const declaredLayout = (
  flags: number,
  classes: readonly Inventory["classes"][number][],
  offsets: readonly Inventory["fields"][number][],
  ownerToken: string,
): ManagedFieldLayout => {
  if (classes.length > 1 || offsets.length > 1) return UNKNOWN;
  const declared = classes[0];
  if (flags === 0)
    return declared === undefined && offsets.length === 0
      ? {
          state: "known",
          kind: "auto",
          packing_size: null,
          class_size: null,
          field_offset: null,
        }
      : UNKNOWN;
  if (flags !== 0x08 && flags !== 0x10) return UNKNOWN;
  const packing = declared?.packing_size ?? 0;
  const size = declared?.class_size ?? 0;
  if (![0, 1, 2, 4, 8, 16, 32, 64, 128].includes(packing)) return UNKNOWN;
  if (flags === 0x08)
    return offsets.length === 0
      ? {
          state: "known",
          kind: "sequential",
          packing_size: packing,
          class_size: size,
          field_offset: null,
        }
      : UNKNOWN;
  const offset = offsets[0];
  if (
    packing !== 0 ||
    offset === undefined ||
    offset.declaring_type_token !== ownerToken
  )
    return UNKNOWN;
  return {
    state: "known",
    kind: "explicit",
    packing_size: 0,
    class_size: size,
    field_offset: offset.offset_bytes,
  };
};
