import type { UnicornEmulationService } from "../application/unicorn/UnicornEmulationService.js";
import type { ContractToolBindings } from "./contractToolBindings.js";

/**
 * Bind Unicorn emulation tools outside session analysis admission: the
 * harness carries raw function bytes, so no binary needs to be open.
 */
export const bindUnicornTools = (
  service: UnicornEmulationService,
): ContractToolBindings => ({
  emulate_function: {
    admission: "application",
    run: (input, options) => service.emulate(input, options),
  },
});
