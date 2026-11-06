/** Read the generated verifier's declared JSON checks; boundary tests independently execute its Python. */
export const readExportedTaskChecks = (verifier: string): unknown => {
  const literal = /^CHECKS = json.loads\((.+)\)$/mu.exec(verifier)?.[1];
  if (literal === undefined)
    throw new Error("The exported verifier has no JSON checks declaration");
  const serialized: unknown = JSON.parse(literal);
  if (typeof serialized !== "string")
    throw new Error("The exported checks declaration does not hold JSON text");
  return JSON.parse(serialized) as unknown;
};
