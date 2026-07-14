import { createHash } from "node:crypto";

import { z } from "zod";

/** Self-verifying text artifact used by web-source analysis boundaries. */
export const webTextArtifactSchema = z
  .object({
    uri: z.string().regex(/^rea:\/\/web-content\/sha256\/[a-f0-9]{64}$/u),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    bytes: z.number().int().min(0),
    media_type: z.string().min(1).max(256),
    charset: z.literal("utf-8"),
    text: z.string(),
  })
  .superRefine((artifact, context) => {
    const bytes = Buffer.byteLength(artifact.text);
    const digest = createHash("sha256").update(artifact.text).digest("hex");
    if (artifact.bytes !== bytes)
      context.addIssue({
        code: "custom",
        path: ["bytes"],
        message: "Byte count mismatch",
      });
    if (artifact.sha256 !== digest)
      context.addIssue({
        code: "custom",
        path: ["sha256"],
        message: "Digest mismatch",
      });
    if (artifact.uri !== webContentUri(digest))
      context.addIssue({
        code: "custom",
        path: ["uri"],
        message: "Content URI mismatch",
      });
  });
export type WebTextArtifact = z.infer<typeof webTextArtifactSchema>;

/** Build an immutable content-addressed UTF-8 text artifact. */
export const createWebTextArtifact = (
  text: string,
  mediaType: string,
): WebTextArtifact => {
  const sha256 = createHash("sha256").update(text).digest("hex");
  return {
    uri: webContentUri(sha256),
    sha256,
    bytes: Buffer.byteLength(text),
    media_type: mediaType,
    charset: "utf-8",
    text,
  };
};

const webContentUri = (sha256: string): string =>
  `rea://web-content/sha256/${sha256}`;
