/**
 * How a hardware name was obtained.
 * An address in an instruction is observed. A controller or register name is
 * assigned only by a published map. A board fact the program does not settle
 * stays unsettled.
 */
export const CONTROLLER_NAME_BASES = [
  "chip_manual",
  "observed_address",
] as const;
export type ControllerNameBasis = (typeof CONTROLLER_NAME_BASES)[number];

export const REGISTER_NAME_BASES = [
  "architecture_manual",
  "observed_address",
] as const;
export type RegisterNameBasis = (typeof REGISTER_NAME_BASES)[number];

export const controllerNameBasis = (named: boolean): ControllerNameBasis =>
  named ? "chip_manual" : "observed_address";

export const registerNameBasis = (named: boolean): RegisterNameBasis =>
  named ? "architecture_manual" : "observed_address";

/** A board statement the captured program does not decide. */
export interface UnsettledBoardFact {
  readonly subject: string;
  readonly basis: "unsettled";
  readonly reason: string;
}

/**
 * One hardware statement is settled only under a named rule.
 * The same rule ids cover controller names, architectural registers, caller-selected
 * board windows, values computed by the image, installed parts, and driver strings.
 */
export const HARDWARE_CLAIM_BASES = [
  "observed_address",
  "instruction",
  "chip_manual",
  "architecture_manual",
  "explicit_profile",
  "unsettled",
] as const;
export type HardwareClaimBasis = (typeof HARDWARE_CLAIM_BASES)[number];

export const HARDWARE_CLAIM_RULES = [
  "observed-address",
  "chip-manual-name",
  "architecture-register",
  "explicit-profile",
  "instruction-decode",
  "installed-part",
  "driver-linkage",
] as const;
export type HardwareClaimRule = (typeof HARDWARE_CLAIM_RULES)[number];

export interface HardwareClaim {
  readonly rule: HardwareClaimRule;
  readonly basis: HardwareClaimBasis;
  readonly settled: boolean;
  readonly reason: string;
}

export type HardwareClaimInput =
  | {
      readonly rule: "observed-address";
      readonly addressSeen: boolean;
      readonly fromRoundedPage: boolean;
    }
  | { readonly rule: "chip-manual-name"; readonly addressHit: boolean }
  | {
      readonly rule: "architecture-register";
      readonly architectureHit: boolean;
      readonly placementIsBoardSpecific: boolean;
    }
  | { readonly rule: "explicit-profile"; readonly profileSelected: boolean }
  | {
      readonly rule: "instruction-decode";
      readonly decodedByInstruction: boolean;
    }
  | {
      readonly rule: "installed-part";
      readonly tableNames: readonly string[];
      readonly deviceName: string | null;
    }
  | {
      readonly rule: "driver-linkage";
      readonly stringPresent: boolean;
      readonly usedAsBootProof: boolean;
    };

const claim = (
  rule: HardwareClaimRule,
  basis: HardwareClaimBasis,
  reason: string,
): HardwareClaim => ({
  rule,
  basis,
  settled: basis !== "unsettled",
  reason,
});

const observedAddressClaim = (
  input: Extract<HardwareClaimInput, { rule: "observed-address" }>,
): HardwareClaim =>
  input.addressSeen && !input.fromRoundedPage
    ? claim(
        input.rule,
        "observed_address",
        "The instruction or literal pool contains this address.",
      )
    : claim(
        input.rule,
        "unsettled",
        "A rounded page base is not an address the instruction accessed.",
      );

const installedPartClaim = (
  input: Extract<HardwareClaimInput, { rule: "installed-part" }>,
): HardwareClaim => {
  const single =
    input.tableNames.length === 1 ? input.tableNames[0] : undefined;
  if (input.tableNames.length > 1) {
    return claim(
      input.rule,
      "unsettled",
      `The image table names ${input.tableNames.join(", ")}. The installed part is the chip that answers.`,
    );
  }
  if (
    single !== undefined &&
    (input.deviceName === null || input.deviceName === single)
  ) {
    return claim(input.rule, "observed_address", `The image names ${single}.`);
  }
  return claim(
    input.rule,
    "unsettled",
    input.deviceName === null
      ? "The image does not name an installed part."
      : `The device name ${input.deviceName} is not a settled part identity.`,
  );
};

/** Apply one hardware rule. Unsettled claims stay open and are not definite values. */
export const decideHardwareClaim = (
  input: HardwareClaimInput,
): HardwareClaim => {
  switch (input.rule) {
    case "observed-address":
      return observedAddressClaim(input);
    case "chip-manual-name":
      return input.addressHit
        ? claim(
            input.rule,
            "chip_manual",
            "The observed address matches one controller window.",
          )
        : claim(
            input.rule,
            "unsettled",
            "No observed address hits a controller window.",
          );
    case "architecture-register":
      return input.architectureHit && !input.placementIsBoardSpecific
        ? claim(
            input.rule,
            "architecture_manual",
            "The observed address matches a register fixed by the architecture.",
          )
        : claim(
            input.rule,
            "unsettled",
            "This register address is selected by a board, not by the CPU family.",
          );
    case "explicit-profile":
      return input.profileSelected
        ? claim(
            input.rule,
            "explicit_profile",
            "The caller selected this memory map or register placement.",
          )
        : claim(
            input.rule,
            "unsettled",
            "The CPU family does not select a board window.",
          );
    case "instruction-decode":
      return input.decodedByInstruction
        ? claim(
            input.rule,
            "instruction",
            "The image's own bit operations compute this value.",
          )
        : claim(
            input.rule,
            "unsettled",
            "The instructions do not compute this split.",
          );
    case "installed-part":
      return installedPartClaim(input);
    case "driver-linkage":
      return input.usedAsBootProof
        ? claim(
            input.rule,
            "unsettled",
            "A driver string does not show that the driver runs during boot.",
          )
        : claim(
            input.rule,
            "observed_address",
            input.stringPresent
              ? "The image contains the driver string."
              : "The image does not contain the driver string.",
          );
  }
};

/** Board records that stay open: no controller binding, or an explicit disagreement. */
export const unsettledBoardFacts = (
  devices: readonly {
    readonly id: string;
    readonly name: string;
    readonly peripheralName: string | null;
    readonly uncertainty?: string;
  }[],
): readonly UnsettledBoardFact[] =>
  devices.flatMap((device) => {
    const facts: UnsettledBoardFact[] = [];
    if (device.peripheralName === null) {
      facts.push({
        subject: device.id,
        basis: "unsettled",
        reason: `${device.name} is named by the board profile and is not bound to a controller in the chip map.`,
      });
    }
    if (device.uncertainty !== undefined) {
      facts.push({
        subject: device.id,
        basis: "unsettled",
        reason: device.uncertainty,
      });
    }
    return facts;
  });
