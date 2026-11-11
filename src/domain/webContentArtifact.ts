import { createHash } from "node:crypto";

import { z } from "zod";

/** Exact facts of the UTF-8 encoding and UTF-16 storage of retained text. */
export const webTextFacts = (text: string) => ({
  sha256: createHash("sha256").update(text).digest("hex"),
  utf8Bytes: Buffer.byteLength(text),
  utf16Units: text.length,
});

/** Metadata shared by complete and summarized retained web text artifacts. */
export const webTextArtifactMetadataSchema = z.object({
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  bytes: z.int().min(0),
  media_type: z.string().min(1),
  charset: z.literal("utf-8"),
});

/** Self-verifying text artifact used by web-source analysis boundaries. */
export const webTextArtifactSchema = webTextArtifactMetadataSchema
  .extend({ text: z.string() })
  .superRefine((artifact, context) => {
    const facts = webTextFacts(artifact.text);
    if (artifact.bytes !== facts.utf8Bytes)
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "Byte count mismatch",
      });
    if (artifact.sha256 !== facts.sha256)
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "Digest mismatch",
      });
  });
export type WebTextArtifact = z.infer<typeof webTextArtifactSchema>;

/** Build an immutable content-addressed UTF-8 text artifact. */
export const createWebTextArtifact = (
  text: string,
  mediaType: string,
): WebTextArtifact => {
  const facts = webTextFacts(text);
  return {
    sha256: facts.sha256,
    bytes: facts.utf8Bytes,
    media_type: mediaType,
    charset: "utf-8",
    text,
  };
};
