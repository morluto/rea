import { expect, it } from "vitest";

import { isLosslessNodeDiscoveryPath } from "./nodeDiscoveryPath.js";

it.for([
  ["/tmp/rea/entry.js", "linux", true],
  ["/tmp/space root/entry#hash.js", "darwin", true],
  ["/tmp/bad_root/entry.js", "linux", false],
  ['/tmp/quote"d/entry.js', "linux", false],
  ["/tmp/back\\slash/entry.js", "linux", false],
  ["relative/entry.js", "linux", false],
  ["/tmp/rea/entry.js", "win32", false],
] as const)(
  "reports whether Node discovery identifies %s on %s exactly",
  ([path, platform, expected]) => {
    expect(isLosslessNodeDiscoveryPath(path, platform)).toBe(expected);
  },
);
