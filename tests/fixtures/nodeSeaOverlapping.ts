import { nodeSeaMachO } from "../../src/artifacts/nodeSea/NodeSea.fixture.js";

/** Eight native section declarations alias a small zero-filled payload. */
export const nodeSeaOverlappingMachO = (exactAliases = false) => {
  const count = 8;
  const blobLength = 16 * 1024;
  const carrier = nodeSeaMachO({
    blob: Buffer.alloc(blobLength),
    extraBlobs: Array.from({ length: count - 1 }, () =>
      Buffer.alloc(blobLength),
    ),
  });
  const payloadAt = 32 + 72 + count * 80;
  const payloadBytes = blobLength + (exactAliases ? 0 : count - 1);
  for (let index = 0; index < count; index++) {
    const shift = exactAliases ? 0 : index;
    const section = 32 + 72 + index * 80;
    carrier.writeBigUInt64LE(BigInt(shift), section + 32);
    carrier.writeUInt32LE(payloadAt + shift, section + 48);
  }
  carrier.writeBigUInt64LE(BigInt(payloadBytes), 32 + 32);
  carrier.writeBigUInt64LE(BigInt(payloadBytes), 32 + 48);
  return {
    bytes: carrier.subarray(0, payloadAt + payloadBytes),
    payloadAt,
    blobLength,
  };
};
