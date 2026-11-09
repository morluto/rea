import { z } from "zod";
import {
  decideHardwareClaim,
  type HardwareClaim,
  type HardwareClaimInput,
} from "./hardwareFactBasis.js";
import {
  lookupSocPeripheral,
  type SocPlatform,
  socPlatformSchema,
} from "./socPeripheralDatabase.js";

/**
 * Image observations the reference edge cannot carry: immediates, pin indexes,
 * bus-name strings, SFUD rows, and vector slots. Controller names come from
 * the existing SoC catalog. This module does not add manual rows.
 */
export interface PinPlacement {
  readonly origin: bigint;
  readonly stride: bigint;
  readonly portLimit: number;
}

export interface VectorManualEntry {
  readonly index: number;
  readonly rule: "architecture-register" | "chip-manual-name";
  readonly name: string;
}

export interface PllFieldLayout {
  readonly name: string;
  readonly shift: number;
  readonly width: number;
}

export type ImageHardwareObservation =
  | {
      readonly kind: "loaded-address";
      readonly site: string;
      readonly address: bigint;
      readonly fromRoundedPage: boolean;
    }
  | { readonly kind: "bus-name"; readonly site: string; readonly name: string }
  | {
      readonly kind: "pin-index";
      readonly site: string;
      readonly index: bigint;
    }
  | {
      readonly kind: "sfud-table";
      readonly tableAddress: string;
      readonly deviceName: string | null;
      readonly rows: readonly {
        readonly address: string;
        readonly name: string;
        readonly jedec: bigint;
        readonly capacity: bigint;
      }[];
    }
  | {
      readonly kind: "vector-slot";
      readonly site: string;
      readonly index: number;
    }
  | {
      readonly kind: "pll-immediate";
      readonly site: string;
      readonly value: bigint;
      readonly fields: readonly PllFieldLayout[];
      /** Null when the image writes the PLL word and does not switch SYSCLK. */
      readonly clockSwitch: { readonly site: string } | null;
    };

export interface ImageHardwareDecodeInput {
  readonly platform: SocPlatform | null;
  readonly pinPlacement: PinPlacement | null;
  readonly vectors: readonly VectorManualEntry[];
  readonly observations: readonly ImageHardwareObservation[];
}

const pinPlacementSchema = z.strictObject({
  origin: z.bigint(),
  stride: z.bigint(),
  portLimit: z.number().int().nonnegative(),
});

const vectorManualEntrySchema = z.strictObject({
  index: z.number().int().nonnegative(),
  rule: z.enum(["architecture-register", "chip-manual-name"]),
  name: z.string(),
});

const pllFieldSchema = z.strictObject({
  name: z.string(),
  shift: z.number().int().nonnegative(),
  width: z.number().int().positive(),
});

const loadedAddressSchema = z.strictObject({
  kind: z.literal("loaded-address"),
  site: z.string(),
  address: z.bigint(),
  fromRoundedPage: z.boolean(),
});

const busNameSchema = z.strictObject({
  kind: z.literal("bus-name"),
  site: z.string(),
  name: z.string(),
});

const pinIndexSchema = z.strictObject({
  kind: z.literal("pin-index"),
  site: z.string(),
  index: z.bigint(),
});

const sfudTableSchema = z.strictObject({
  kind: z.literal("sfud-table"),
  tableAddress: z.string(),
  deviceName: z.string().nullable(),
  rows: z.array(
    z.strictObject({
      address: z.string(),
      name: z.string(),
      jedec: z.bigint(),
      capacity: z.bigint(),
    }),
  ),
});

const vectorSlotSchema = z.strictObject({
  kind: z.literal("vector-slot"),
  site: z.string(),
  index: z.number().int().nonnegative(),
});

const pllImmediateSchema = z.strictObject({
  kind: z.literal("pll-immediate"),
  site: z.string(),
  value: z.bigint(),
  fields: z.array(pllFieldSchema),
  clockSwitch: z.strictObject({ site: z.string() }).nullable(),
});

export const imageHardwareDecodeInputSchema = z.strictObject({
  platform: socPlatformSchema.nullable(),
  pinPlacement: pinPlacementSchema.nullable(),
  vectors: z.array(vectorManualEntrySchema),
  observations: z.array(
    z.discriminatedUnion("kind", [
      loadedAddressSchema,
      busNameSchema,
      pinIndexSchema,
      sfudTableSchema,
      vectorSlotSchema,
      pllImmediateSchema,
    ]),
  ),
});

const hex = (value: bigint): string => `0x${value.toString(16)}`;

const claimFrom = (
  input: HardwareClaimInput,
  subject: string,
  source: string,
): HardwareClaim => {
  const decision = decideHardwareClaim(input);
  return { subject, source, ...decision };
};

const fieldValue = (word: bigint, field: PllFieldLayout): bigint => {
  const mask = (1n << BigInt(field.width)) - 1n;
  return (word >> BigInt(field.shift)) & mask;
};

const loadedAddressClaims = (
  observation: Extract<ImageHardwareObservation, { kind: "loaded-address" }>,
  platform: SocPlatform | null,
): HardwareClaim[] => {
  const hit =
    platform === null
      ? null
      : lookupSocPeripheral(observation.address, platform);
  return [
    claimFrom(
      {
        rule: "observed-address",
        addressSeen: true,
        fromRoundedPage: observation.fromRoundedPage,
      },
      hex(observation.address),
      observation.site,
    ),
    claimFrom(
      { rule: "chip-manual-name", addressHit: hit !== null },
      hit?.name ?? hex(observation.address),
      observation.site,
    ),
  ];
};

const pinClaims = (
  observation: Extract<ImageHardwareObservation, { kind: "pin-index" }>,
  platform: SocPlatform | null,
  placement: PinPlacement | null,
): HardwareClaim[] => {
  const port = observation.index >> 4n;
  const pin = observation.index & 0xfn;
  const selected = placement !== null && port < BigInt(placement.portLimit);
  const base =
    selected && placement !== null
      ? placement.origin + port * placement.stride
      : null;
  const hit =
    base !== null && platform !== null
      ? lookupSocPeripheral(base, platform)
      : null;
  const index = hex(observation.index);
  return [
    claimFrom(
      { rule: "instruction-decode", decodedByInstruction: true },
      `pin:${index}`,
      `${observation.site} port=${port} pin=${pin}`,
    ),
    claimFrom(
      { rule: "explicit-profile", profileSelected: base !== null },
      `pin-base:${index}`,
      base === null ? observation.site : hex(base),
    ),
    claimFrom(
      { rule: "chip-manual-name", addressHit: hit !== null },
      `pin-name:${index}`,
      hit === null ? observation.site : `${observation.site} ${hit.name}`,
    ),
    claimFrom(
      {
        rule: "board-record",
        statement:
          "The pin index names a port and a pin. The instructions do not name the board device on that pin.",
      },
      `gpio-role:${port}:${pin}`,
      observation.site,
    ),
  ];
};

const sfudClaims = (
  observation: Extract<ImageHardwareObservation, { kind: "sfud-table" }>,
): HardwareClaim[] => {
  const rows = observation.rows.flatMap((row) => [
    claimFrom(
      {
        rule: "driver-linkage",
        stringPresent: true,
        usedAsBootProof: false,
      },
      `sfud:${row.address}:name`,
      row.name,
    ),
    claimFrom(
      { rule: "instruction-decode", decodedByInstruction: true },
      `sfud:${row.address}:jedec`,
      hex(row.jedec),
    ),
    claimFrom(
      { rule: "instruction-decode", decodedByInstruction: true },
      `sfud:${row.address}:capacity`,
      hex(row.capacity),
    ),
  ]);
  return [
    ...rows,
    claimFrom(
      {
        rule: "installed-part",
        tableNames: observation.rows.map((row) => row.name),
        deviceName: observation.deviceName,
        answered: false,
      },
      "spi-flash-part",
      observation.tableAddress,
    ),
  ];
};

const vectorClaim = (
  observation: Extract<ImageHardwareObservation, { kind: "vector-slot" }>,
  vectors: readonly VectorManualEntry[],
): HardwareClaim => {
  const entry = vectors.find((item) => item.index === observation.index);
  if (entry?.rule === "architecture-register") {
    return claimFrom(
      {
        rule: "architecture-register",
        architectureHit: true,
        placementIsBoardSpecific: false,
      },
      entry.name,
      observation.site,
    );
  }
  if (entry?.rule === "chip-manual-name") {
    return claimFrom(
      { rule: "chip-manual-name", addressHit: true },
      entry.name,
      observation.site,
    );
  }
  return claimFrom(
    { rule: "chip-manual-name", addressHit: false },
    `vector:${observation.index}`,
    observation.site,
  );
};

const pllClaims = (
  observation: Extract<ImageHardwareObservation, { kind: "pll-immediate" }>,
): HardwareClaim[] => {
  const fields = observation.fields.map((field) =>
    claimFrom(
      { rule: "instruction-decode", decodedByInstruction: true },
      `pll:${observation.site}:${field.name}`,
      `${hex(observation.value)}=${fieldValue(observation.value, field)}`,
    ),
  );
  return [
    ...fields,
    claimFrom(
      {
        rule: "instruction-decode",
        decodedByInstruction: observation.clockSwitch !== null,
      },
      `pll-frequency:${observation.site}`,
      observation.clockSwitch?.site ?? observation.site,
    ),
  ];
};

const claimsForObservation = (
  observation: ImageHardwareObservation,
  input: ImageHardwareDecodeInput,
): HardwareClaim[] => {
  switch (observation.kind) {
    case "loaded-address":
      return loadedAddressClaims(observation, input.platform);
    case "bus-name":
      return [
        claimFrom(
          {
            rule: "driver-linkage",
            stringPresent: true,
            usedAsBootProof: false,
          },
          observation.name,
          observation.site,
        ),
      ];
    case "pin-index":
      return pinClaims(observation, input.platform, input.pinPlacement);
    case "sfud-table":
      return sfudClaims(observation);
    case "vector-slot":
      return [vectorClaim(observation, input.vectors)];
    case "pll-immediate":
      return pllClaims(observation);
  }
};

/** Decode image observations into claims. A bus name never becomes a controller. */
export const hardwareClaimsFromImage = (
  input: ImageHardwareDecodeInput,
): readonly HardwareClaim[] =>
  input.observations.flatMap((observation) =>
    claimsForObservation(observation, input),
  );
