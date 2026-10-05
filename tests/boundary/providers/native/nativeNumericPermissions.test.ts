import { expect, it } from "vitest";
import { parseOtoolLoadCommands } from "../../../../src/native/parsers/otool.js";

it.each([0, 1, 2, 3, 4, 5, 6, 7])(
  "decodes Mach VM protection bits for mask %i",
  (mask) => {
    const parsed = parseOtoolLoadCommands(`Load command 0
      cmd LC_SEGMENT_64
  segname __DATA
  maxprot 0x${mask.toString(16)}
 initprot ${mask}
`);
    for (const permissions of [
      parsed.segments[0]?.maximum_permissions,
      parsed.segments[0]?.initial_permissions,
    ]) {
      expect(permissions).toMatchObject({
        read: (mask & 1) !== 0,
        write: (mask & 2) !== 0,
        execute: (mask & 4) !== 0,
      });
    }
  },
);
