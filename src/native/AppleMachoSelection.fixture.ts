import { malformedInput } from "../domain/parseFailure.js";
import {
  parseMachoLayout,
  type MachoLayout,
} from "../domain/apple/appleMachoSelection.js";
import {
  selectMachoSlice,
  type AdmittedMachoSlice,
  type MachoSliceSelectionRefusal,
} from "../domain/apple/machoSliceSelection.js";

/** A refused admitted selection, thrown so a test can assert its kind. */
export class MachoSliceRefused extends Error {
  constructor(readonly refusal: MachoSliceSelectionRefusal) {
    super(refusal.message);
  }
}

/** Select the admitted image, then parse its layout, as the metadata readers do. */
export const layoutFor = (
  bytes: Buffer,
  architecture: string,
  slice?: AdmittedMachoSlice,
): MachoLayout => {
  const selected = selectMachoSlice(bytes, {
    mode: "admitted",
    architecture,
    slice,
  });
  if (selected.ok) return parseMachoLayout(bytes, selected.value);
  if (selected.error.kind === "malformed")
    throw malformedInput("macho", selected.error.message);
  throw new MachoSliceRefused(selected.error);
};
