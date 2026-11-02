/** Unchanged upstream source pin; executed bytes are identified separately. */
export const WAKARU_RELEASE = {
  version: "1.14.0",
  revision: "8219bf5016a063d7fb215101a8c45d5959ec733f",
  repository: "https://github.com/pionxzh/wakaru",
} as const;

/** Catalog identity for the verified Wakaru release. Evidence replaces version with the observed banner. */
export const WAKARU_PROVIDER_IDENTITY = {
  id: "wakaru",
  name: "Wakaru",
  version: WAKARU_RELEASE.version,
} as const;
