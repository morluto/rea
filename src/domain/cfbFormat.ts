const CFB_SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");

/** Storage-family identification only; this does not validate CFB/MSI contents. */
export const hasCfbSignature = (prefix: Buffer): boolean =>
  prefix.length >= CFB_SIGNATURE.length &&
  prefix.subarray(0, CFB_SIGNATURE.length).equals(CFB_SIGNATURE);

/** Shared root/nested coverage fact until a bounded stream reader is available. */
export const CFB_INVENTORY_LIMITATION =
  "CFB container signature is observed; header validation, child stream inventory, MSI table interpretation, and cabinet expansion are unavailable.";
