import { describe, expect, it } from "vitest";
import {
  privateArtifacts,
  verifyRuntimeAccess,
} from "../../../scripts/lib/windows-private-runtime-access.mjs";

const root = String.raw`C:\qualification\private-cafe`;
const owner = "S-1-5-21-1-2-3-1001";
const other = "S-1-5-21-1-2-3-1002";
const system = "S-1-5-18";
const readback = (sid: string, result: number) => ({
  root,
  sid,
  localUser: sid !== system,
  administrator: sid === system,
  control: 0,
  files: Object.fromEntries(privateArtifacts.map((file) => [file, result])),
});

describe("Windows private runtime access proof", () => {
  it("requires reads by the owner and SYSTEM and access denied for a different local user", () => {
    expect(verifyRuntimeAccess(root, owner, readback(owner, 0))).toBe("owner");
    expect(verifyRuntimeAccess(root, owner, readback(system, 0))).toBe(
      "SYSTEM",
    );
    expect(verifyRuntimeAccess(root, owner, readback(other, 5))).toBe(
      "unrelated user",
    );
  });

  it.each([0, 2, 32])(
    "rejects a peer file result of %i instead of access denied",
    (result) => {
      const observation = readback(other, 5);
      observation.files["session.token"] = result;
      expect(() => verifyRuntimeAccess(root, owner, observation)).toThrow(
        /session.token/u,
      );
    },
  );

  it("rejects missing files, an inaccessible control and evidence from another root or authority", () => {
    const peer = readback(other, 5);
    for (const changed of [
      { files: {} },
      { root: `${root}-other` },
      { control: 5 },
      { localUser: false },
      { administrator: true },
      { sid: owner },
      { sid: system },
    ]) {
      expect(() =>
        verifyRuntimeAccess(root, owner, { ...peer, ...changed }),
      ).toThrow();
    }
  });
});
