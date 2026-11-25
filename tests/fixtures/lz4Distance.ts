import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";

const oracleSchema = z.object({
  encoded_hex: z.string(),
  decoded_bytes: z.int(),
  decoded_sha256: z.string(),
});

/** Source bytes are constructed before compression by the independent producer. */
export const lz4DistanceFixture = async () => {
  const oracle = oracleSchema.parse(
    JSON.parse(
      await readFile(
        new URL("./lz4-distance/oracle.json", import.meta.url),
        "utf8",
      ),
    ),
  );
  const prefix = Buffer.concat(
    Array.from({ length: 17 }, (_, index) =>
      createHash("sha256")
        .update(`rea-lz4-distance:${index}`, "ascii")
        .digest(),
    ),
  ).subarray(0, 513);
  const source = Buffer.concat([prefix, prefix, Buffer.from("END!\0")]);
  if (
    source.length !== oracle.decoded_bytes ||
    createHash("sha256").update(source).digest("hex") !== oracle.decoded_sha256
  )
    throw new Error("LZ4 source recipe no longer matches the producer oracle");
  return {
    source,
    encoded: Buffer.from(oracle.encoded_hex, "hex"),
    sha256: oracle.decoded_sha256,
  };
};
