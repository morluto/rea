/** Check a schema-validated nonnegative byte range against its carrier size. */
export const insideArtifact =
  (fileBytes: number) =>
  ({
    offset,
    bytes,
  }: {
    readonly offset: number;
    readonly bytes: number;
  }): boolean =>
    offset <= fileBytes - bytes;
