import { isGdbStreamRecord } from "../domain/commandObservation.js";

/** Snapshot ordered MI records and retain their raw stream encodings. */
export const snapshotGdbCommandRecords = (records: readonly string[]) => {
  const snapshot = [...records];
  const stream = (name: "console" | "target" | "log") =>
    snapshot.filter((line) => isGdbStreamRecord(line, name)).join("\n");
  return {
    records: snapshot,
    console: stream("console"),
    target: stream("target"),
    log: stream("log"),
  };
};
