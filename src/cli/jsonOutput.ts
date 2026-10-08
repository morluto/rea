import type { Writable } from "node:stream";

import { bufferedJsonParts, jsonParts } from "../domain/jsonSerialization.js";

type JsonOutputFormat = "json" | "jsonl";

/** Write ordinary JSON without constructing a document-sized string. */
export const writeJsonOutput = async (
  value: unknown,
  destination: Writable,
  format: JsonOutputFormat = "json",
): Promise<void> => {
  for (const part of bufferedJsonParts(documentParts(value, format)))
    await writePart(destination, part);
};

const writePart = (destination: Writable, part: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const onError = (cause: unknown): void => reject(cause);
    destination.once("error", onError);
    try {
      destination.write(part, (cause) => {
        if (cause) {
          // A Writable can emit its error after invoking the write callback.
          setImmediate(() => destination.off("error", onError));
          reject(cause);
        } else {
          destination.off("error", onError);
          resolve();
        }
      });
    } catch (cause: unknown) {
      destination.off("error", onError);
      reject(cause);
    }
  });

function* documentParts(
  value: unknown,
  format: JsonOutputFormat,
): Generator<string> {
  if (format === "jsonl" && Array.isArray(value)) {
    for (const item of value) {
      yield* jsonParts(item);
      yield "\n";
    }
    return;
  }
  yield* jsonParts(value, format === "json");
  yield "\n";
}
