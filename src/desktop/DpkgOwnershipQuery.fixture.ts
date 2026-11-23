/** A partial dpkg reply with a diversion, one exact owner, and a path that decodes lossily. */
export const mixedDpkgOwnershipStdout = (
  ownedPath: string,
  damagedPath: string,
): Buffer => {
  const marker = damagedPath.indexOf("\uFFFD");
  if (marker < 0) throw new Error("Expected a replacement marker in the path");
  return Buffer.concat([
    Buffer.from(
      `local diversion from: ${ownedPath}\nactual-owner: ${ownedPath}\nwrong-owner: ${damagedPath.slice(0, marker)}`,
    ),
    Buffer.from([0xff]),
    Buffer.from(`${damagedPath.slice(marker + 1)}\n`),
  ]);
};
