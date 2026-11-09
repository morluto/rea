/** Distinguish a file that is not a Shell Link from later structural damage. */
export class WindowsShortcutFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "WindowsShortcutFormatFailure";
  }
}

/** Caller-selected budgets that bound Shell Link expansion. */
export type WindowsShortcutSelectedBoundary =
  | "id_list_items"
  | "extra_data_blocks"
  | "string_bytes";

/** Resource boundary exceeded while walking a Shell Link file. */
export class WindowsShortcutResourceFailure extends Error {
  constructor(
    readonly boundary: WindowsShortcutSelectedBoundary,
    readonly maximum: number,
    message: string,
  ) {
    super(message);
    this.name = "WindowsShortcutResourceFailure";
  }
}
