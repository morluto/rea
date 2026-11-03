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
