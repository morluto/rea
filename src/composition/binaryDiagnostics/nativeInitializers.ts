import { NativeInitializersService } from "../../application/binaryDiagnostics/NativeInitializersService.js";
import { NativeInitializersProvider } from "../../native/initializers/NativeInitializersProvider.js";

/** Portable ELF and Mach-O initializer and finalizer listing with no engine. */
export const createNativeInitializersService = (): NativeInitializersService =>
  new NativeInitializersService(new NativeInitializersProvider());
