/** Expected carrier encoding failure, independent of the analysis engine. */
export class EvmCarrierFailure extends Error {}

/** Decode only the explicitly selected representation; source carrier bytes are retained separately. */
export const decodeEvmBytecodeCarrier = (
  bytes: Uint8Array,
  encoding: "raw" | "hex",
): Uint8Array => {
  if (encoding === "raw") return Uint8Array.from(bytes);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      bytes,
    );
  } catch (cause: unknown) {
    throw new EvmCarrierFailure("Hex carrier must be valid UTF-8.", { cause });
  }
  const code = text
    .replace(/^[\x09-\x0d\x20]+|[\x09-\x0d\x20]+$/g, "")
    .replace(/^0x/i, "");
  if (!/^(?:[a-fA-F0-9]{2})*$/.test(code))
    throw new EvmCarrierFailure(
      "Hex carrier requires complete hexadecimal byte pairs, an optional 0x prefix and outer ASCII whitespace; interior separators are invalid.",
    );
  return Uint8Array.from(Buffer.from(code, "hex"));
};
