import type { ManagedMemberInspection } from "./managedArtifact.js";

type Method = ManagedMemberInspection["methods"][number];
type Field = ManagedMemberInspection["fields"][number];

/**
 * The exact signature across builds: raw bytes with type operands resolved to
 * names. Raw bytes name types by build-local rows, so they stand in only when
 * REA could not resolve the operands.
 * The kind is part of the key: an undecodable blob can hold another
 * signature's resolved preimage, so its raw digest can equal that resolved
 * digest without the two being the same signature.
 */
export const signatureIdentity = ({
  raw_sha256,
  resolved_sha256,
}: Method["signature"]): string =>
  resolved_sha256 === null
    ? `raw:${raw_sha256}`
    : `resolved:${resolved_sha256}`;
