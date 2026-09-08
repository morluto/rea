import { createStoreFileLock } from "../../dist/application/StoreFileLock.js";

const path = process.argv[2];
if (path === undefined) throw new Error("A lock path is required");
await createStoreFileLock(path);
// Exit without invoking release so the parent can exercise dead-owner recovery.
