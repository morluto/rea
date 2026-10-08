import { parentPort, workerData } from "node:worker_threads";
import { z } from "zod";

const input = z
  .strictObject({
    pattern: z.string().min(1),
    caseSensitive: z.boolean(),
    values: z.array(z.string()),
  })
  .parse(workerData);

let expression: RegExp | undefined;
try {
  expression = new RegExp(input.pattern, input.caseSensitive ? "u" : "iu");
} catch (cause: unknown) {
  parentPort?.postMessage({
    status: "invalid_pattern",
    reason: cause instanceof Error ? cause.message : String(cause),
  });
}
if (expression !== undefined) {
  const indices = [];
  for (const [index, value] of input.values.entries()) {
    if (expression.test(value)) indices.push(index);
  }
  parentPort?.postMessage({ status: "matched", indices });
}
