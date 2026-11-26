/** Standard peripheral bus interconnect kinds. */
export type PeripheralBusKind =
  | "APB1"
  | "APB2"
  | "AHB"
  | "AHB1"
  | "AHB2"
  | "AHB3"
  | "AHB4"
  | "APB"
  | "AHBL"
  | "DPort"
  | "PeriBUS1"
  | "PeriBUS2"
  | "RTC"
  | "System";

export const PERIPHERAL_BUS_KINDS = [
  "APB1",
  "APB2",
  "AHB",
  "AHB1",
  "AHB2",
  "AHB3",
  "AHB4",
  "APB",
  "AHBL",
  "DPort",
  "PeriBUS1",
  "PeriBUS2",
  "RTC",
  "System",
] as const satisfies readonly PeripheralBusKind[];

export interface InternalPeripheralEntry {
  readonly name: string;
  readonly base: bigint;
  readonly size: number;
  readonly bus: PeripheralBusKind;
  readonly description: string;
  /**
   * For RP2040-style 4x 4 KiB atomic alias slots (RW, XOR, SET, CLR), the
   * implemented register span inside each 0x1000 alias page. Offsets within the
   * 0x4000 slot whose `(offset & 0xfff) >= aliasPageRegisterBytes` are unmapped.
   */
  readonly aliasPageRegisterBytes?: number;
}

export const peripheralEntry = (
  name: string,
  base: bigint,
  size: number,
  bus: PeripheralBusKind,
  description: string,
): InternalPeripheralEntry => ({ name, base, size, bus, description });

export const atomicAliasEntry = (
  name: string,
  base: bigint,
  bus: PeripheralBusKind,
  registerSpan: number,
  description: string,
): InternalPeripheralEntry => ({
  name,
  base,
  size: 0x4000,
  bus,
  description,
  aliasPageRegisterBytes: registerSpan,
});
