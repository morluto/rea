import assert from "node:assert/strict";
import * as z from "zod";

export const privateArtifacts = [
  "descriptor.json",
  "session.token",
  "snapshot.bin",
  "session.log",
  "project/data.bin",
] as const;

const observation = z.strictObject({
  root: z.string(),
  sid: z.string().regex(/^S-1-(?:5-18|5-21-(?:\d+-){3}\d+)$/u),
  localUser: z.boolean(),
  administrator: z.boolean(),
  control: z.number().int(),
  files: z.record(z.enum(privateArtifacts), z.number().int()),
});

export function verifyRuntimeAccess(
  root: string,
  ownerSid: string,
  input: unknown,
) {
  const observed = observation.parse(input);
  assert.equal(
    observed.root,
    root,
    "Observation belongs to a different runtime",
  );
  assert.equal(
    observed.control,
    0,
    "Peer could not read the adjacent control file",
  );
  const role =
    observed.sid === "S-1-5-18"
      ? "SYSTEM"
      : observed.sid === ownerSid
        ? "owner"
        : "unrelated user";
  if (role !== "SYSTEM") {
    assert.ok(
      observed.localUser && !observed.administrator,
      "Expected an ordinary local user",
    );
    assert.equal(
      observed.sid.slice(0, observed.sid.lastIndexOf("-")),
      ownerSid.slice(0, ownerSid.lastIndexOf("-")),
      "Expected accounts on the same machine",
    );
  }
  for (const file of privateArtifacts) {
    assert.equal(
      observed.files[file],
      role === "unrelated user" ? 5 : 0,
      `${role}: ${file}`,
    );
  }
  return role;
}
