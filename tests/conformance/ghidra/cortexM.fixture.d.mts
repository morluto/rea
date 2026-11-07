/**
 * The Cortex-M0 image at `base`, after `prefix` bytes: a vector table whose
 * Reset word points at the Thumb code at offset 0x40, then that code.
 */
export function cortexM0Fixture(base: number, prefix?: number): Buffer;
