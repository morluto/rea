/** Distinguish corrupt POM/module bytes from layouts this reader does not admit. */
export class MavenGradleMetadataFormatFailure extends Error {
  constructor(
    readonly kind: "malformed" | "unsupported",
    message: string,
  ) {
    super(message);
    this.name = "MavenGradleMetadataFormatFailure";
  }
}
