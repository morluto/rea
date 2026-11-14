import type { FixedAllowance } from "../domain/fixedAllowanceRemediation.js";

/** Fixed method-93 decoder window: 2^27 bytes, matching the ELF/GPU decoders. */
export const ZIP_ZSTANDARD_WINDOW_LOG_MAX = 27;

const ZIP_ZSTANDARD_WINDOW_ALLOWANCE = `${String(2 ** (ZIP_ZSTANDARD_WINDOW_LOG_MAX - 20))} MiB`;

/** A frame above the window cap is a deliberate resource refusal, not damage. */
export const ZIP_ZSTANDARD_WINDOW_LIMIT = `ZIP Zstandard member requires a decoder window above REA's fixed ${ZIP_ZSTANDARD_WINDOW_ALLOWANCE} allowance; the archive is not necessarily corrupt, and this limit cannot be raised at runtime. Recompress the member with a window of at most ${ZIP_ZSTANDARD_WINDOW_ALLOWANCE}, or decompress it with a tool that admits larger windows, then retry.`;

/** The fixed allowance a Zstandard window refusal names in its public recovery. */
export const ZIP_ZSTANDARD_WINDOW_FIXED_ALLOWANCE = `REA's fixed ${ZIP_ZSTANDARD_WINDOW_ALLOWANCE} ZIP Zstandard decoder window`;

/** Typed marker the window refusal carries, so consumers never classify its message text. */
export const ZIP_ZSTANDARD_WINDOW_MARKER: FixedAllowance = {
  name: ZIP_ZSTANDARD_WINDOW_FIXED_ALLOWANCE,
  kind: "parser",
};
