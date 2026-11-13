import { jsonValueByteLength } from "../domain/jsonValueByteLength.js";
import type { JsonValue } from "../domain/jsonValue.js";
import type { UnityAddressablesReadOptions } from "./UnityAddressablesShared.js";

// Minimum serialized row shapes. Actual rows are charged exactly before
// retention; this lower bound never refuses a report that would fit.
const MINIMUM_KEY = JSON.stringify({
  kind: "string",
  value: "",
  type_name: null,
  locations: [],
}).length;
const MINIMUM_LOCATION = JSON.stringify({
  primary_key: "",
  internal_id: "",
  provider_id: "",
  resource_type: null,
  dependencies: [],
  dependency_key: null,
  dependency_hash: 0,
  data: null,
  offset: null,
}).length;

/** Per-snapshot admission: counts first, text before expansion, each row before retention. */
export const createUnityAddressablesAdmission = (
  limit: number,
  exceed: () => never,
): Required<UnityAddressablesReadOptions> => {
  let used = 0;
  return {
    beforeRows({ keys, locations }) {
      if (keys * MINIMUM_KEY + locations * MINIMUM_LOCATION > limit) exceed();
    },
    beforeText(bytes) {
      if (bytes > limit - used) exceed();
    },
    onRow(row) {
      const bytes = jsonValueByteLength(row as JsonValue, limit - used);
      if (bytes > limit - used) exceed();
      used += bytes;
    },
  };
};
