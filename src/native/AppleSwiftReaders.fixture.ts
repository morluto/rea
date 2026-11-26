export const swiftFixtureLocation = (address: bigint) => ({
  address: `0x${address.toString(16)}`,
  file_offset: Number(address),
});

export const swiftFixtureEvidence = (address: bigint, description: string) => [
  {
    kind: "binary_metadata" as const,
    description,
    location: swiftFixtureLocation(address),
    artifact_path: "/fixture",
    artifact_sha256: "a".repeat(64),
  },
];
