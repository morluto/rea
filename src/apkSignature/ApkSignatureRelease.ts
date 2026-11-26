import { APK_SIGNATURE_BUDGETS } from "../domain/apkSignature/apkSignatureBudgets.js";

/** Identity of REA's in-process APK signature reader (no external engine, no device). */
export const APK_SIGNATURE_PROVIDER_IDENTITY = {
  id: "apk-signature",
  name: "REA APK signature reader",
  version: null,
} as const;

export const APK_SIGNATURE_LIMITS = {
  /** Pending requests retain no APK bytes; process-wide scans are serialized. */
  waitingScans: 8,
  /**
   * Default whole-APK bounded read; the content digest needs the whole file.
   * Above Play's 200 MB APK ceiling with headroom for sideloaded/system APKs.
   */
  inputBytes: APK_SIGNATURE_BUDGETS.max_file_bytes.default_value,
  /**
   * One v1 signature block (PKCS#7) after inflation. Real blocks hold a
   * certificate or a short chain (a few KiB); this bounds each inflation.
   */
  v1BlockBytes: 1024 * 1024,
  /** Default inline result ceiling, projected before materialising and re-checked exactly; refused, not truncated. */
  outputBytes: APK_SIGNATURE_BUDGETS.max_output_bytes.default_value,
} as const;
