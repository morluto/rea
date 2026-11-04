/** Source-owned static provider identity and public operation names. */
export const GDB_PROVIDER_IDENTITY = {
  id: "gnu.gdb",
  name: "GNU GDB",
  version: null,
} as const;

/** Only this exact, argument-free control can reuse an already admitted run. */
export const isGdbInterruptCommand = (command: string): boolean =>
  command.trim() === "interrupt";

/** Only explicit target disposition may run while its debugger retains ownership. */
export const isGdbTargetDispositionCommand = (command: string): boolean =>
  command.trim() === "kill" || command.trim() === "detach";
