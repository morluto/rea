import { z } from "zod";

import { canonicalBase64Schema } from "../domain/stringPatterns.js";

/** Where a data-plane file part names its path in the home. */
export const DATA_OBJECTS = "urn:agentenv:data-objects/v1";
/** A `data/get` answer: file parts, each naming its home path, or an error. */
export const dataGetSchema = z.union([
  z.object({
    result: z.object({
      parts: z.array(
        z.looseObject({
          file: z
            .looseObject({ bytes: canonicalBase64Schema.optional() })
            .optional(),
          metadata: z
            .looseObject({
              [DATA_OBJECTS]: z
                .looseObject({ path: z.string().optional() })
                .optional(),
            })
            .optional(),
        }),
      ),
    }),
  }),
  z.object({ error: z.looseObject({ message: z.string() }) }),
]);
const answerSchema = z.union([
  z.object({ result: z.looseObject({}) }),
  z.object({ error: z.looseObject({ message: z.string() }) }),
]);

/**
 * Write files under a computer user's home, by home path, through the
 * driver's `data/add`, sent by `post` to the computer's own RPC route;
 * `redacted` strips the control token from an error the computer returns.
 */
export const writeHomeFiles = async (
  post: (body: unknown) => Promise<unknown>,
  redacted: (text: string) => string,
  files: ReadonlyMap<string, Buffer>,
): Promise<void> => {
  const parts = [...files].map(([path, bytes]) => ({
    kind: "file",
    file: { bytes: bytes.toString("base64") },
    metadata: { [DATA_OBJECTS]: { path } },
  }));
  const answer = answerSchema.parse(
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "data/add",
      params: { parts },
    }),
  );
  if ("error" in answer)
    throw new Error(`data/add failed: ${redacted(answer.error.message)}`);
};

/** The decoded file parts under paths of a computer user's home, each with the home path it names, through the driver's `data/get` sent by `post`. */
export const readHomeFiles = async (
  post: (body: unknown) => Promise<unknown>,
  redacted: (text: string) => string,
  paths: readonly string[],
): Promise<
  readonly { readonly path: string | undefined; readonly bytes: Buffer }[]
> => {
  const answer = dataGetSchema.parse(
    await post({
      jsonrpc: "2.0",
      id: 1,
      method: "data/get",
      params: { paths },
    }),
  );
  if ("error" in answer)
    throw new Error(`data/get failed: ${redacted(answer.error.message)}`);
  return answer.result.parts.flatMap((part) => {
    const encoded = part.file?.bytes;
    return encoded === undefined
      ? []
      : [
          {
            path: part.metadata?.[DATA_OBJECTS]?.path,
            bytes: Buffer.from(encoded, "base64"),
          },
        ];
  });
};
