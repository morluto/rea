/** Register the Ghidra bridge reads for one language. MIPS is not an ARM context. */
export const ghidraProcessorContextRegister = (
  languageId: string,
): "ISA_MODE" | "TMode" | null => {
  if (languageId.startsWith("MIPS:")) return "ISA_MODE";
  if (languageId.startsWith("ARM:")) return "TMode";
  return null;
};

/** Decoder context the bridge returns for a language and the value it observed. */
export const ghidraDecoderContext = (
  languageId: string,
  value: string | null,
): readonly {
  readonly register: "ISA_MODE" | "TMode";
  readonly value: string | null;
  readonly source: "ghidra-program-context";
}[] => {
  const register = ghidraProcessorContextRegister(languageId);
  if (register === null) return [];
  return [{ register, value, source: "ghidra-program-context" }];
};
