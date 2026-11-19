import { V8CodeCacheService } from "../application/v8CodeCache/V8CodeCacheService.js";
import { V8CodeCacheProvider } from "../v8/V8CodeCacheProvider.js";

/** Compose bundled V8 code cache inspection without a V8 runtime or any child process. */
export const createV8CodeCacheService = (): V8CodeCacheService =>
  new V8CodeCacheService(new V8CodeCacheProvider());
