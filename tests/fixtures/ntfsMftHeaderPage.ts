import { mftFileRecord } from "./ntfsMftExtension.js";

/** 40 FILE records across 42 physical slots; the gaps are not header rows. */
export const mftHeaderPageFixture = (): Buffer =>
  Buffer.concat(
    Array.from({ length: 42 }, (_, slot) =>
      slot === 4 || slot === 33
        ? Buffer.alloc(1024)
        : mftFileRecord(slot, 1, []),
    ),
  );
