import { ParseFailureError } from "../../domain/parseFailure.js";

/** Caller-selected budgets that bound Shell Link expansion. */
export type WindowsShortcutSelectedBoundary =
  | "id_list_items"
  | "extra_data_blocks"
  | "string_bytes";

/** Resource boundary exceeded while walking a Shell Link file. */
export class WindowsShortcutResourceFailure extends ParseFailureError<"limit"> {
  declare readonly failure: ParseFailureError<"limit">["failure"] & {
    readonly limit: { readonly name: WindowsShortcutSelectedBoundary };
  };

  constructor(
    boundary: WindowsShortcutSelectedBoundary,
    maximum: number,
    detail: string,
  ) {
    super({
      kind: "limit",
      format: "windows-shortcut",
      detail,
      limit: { name: boundary, maximum },
    });
    this.name = "WindowsShortcutResourceFailure";
  }
}
