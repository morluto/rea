import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { recordBuildCache } from "./build-cache.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
await recordBuildCache(root);
