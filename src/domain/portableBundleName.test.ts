import { expect, it } from "vitest";

import {
  parsePortableBundleName,
  portableBundleNameSchema,
} from "./portableBundleName.js";
import { isPortablePathSegment } from "./portablePathSegment.js";

it.each(["com0", "lpt0", "com1", "lpt9", "con", "nul"])(
  "rejects Windows device name %s before creating a bundle folder",
  (name) => {
    expect(isPortablePathSegment(name)).toBe(false);
    expect(parsePortableBundleName(name)).toEqual({
      ok: false,
      error: "reserved",
    });
    expect(portableBundleNameSchema.safeParse(name).success).toBe(false);
  },
);

it.each(["com10", "lpt10", "com0-backup", "lpt0-data", "my-agent"])(
  "accepts portable label %s",
  (name) => {
    expect(isPortablePathSegment(name)).toBe(true);
    expect(parsePortableBundleName(name)).toEqual({ ok: true, value: name });
    expect(portableBundleNameSchema.safeParse(name).success).toBe(true);
  },
);
