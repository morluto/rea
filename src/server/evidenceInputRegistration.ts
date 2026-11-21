/** Internal registration facts derived from canonical Evidence input contracts. */
const evidenceInputs = new WeakSet<object>();

export const markEvidenceInput = <T extends object>(schema: T): T => {
  evidenceInputs.add(schema);
  return schema;
};

export const canReferenceInlineEvidence = (schema: unknown): boolean =>
  typeof schema === "object" && schema !== null && evidenceInputs.has(schema);
