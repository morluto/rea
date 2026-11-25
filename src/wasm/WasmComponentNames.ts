import type { DecodedComponent } from "../domain/wasm/wasmComponent.js";
import {
  isWasmComponentFormatFailure,
  type WasmComponentFormatFailure,
  type WasmComponentReader,
} from "./WasmComponentReader.js";
import { decodeSort } from "./WasmComponentTypes.js";

const COMPONENT_NAME = "component-name";
type ComponentNames = NonNullable<DecodedComponent["names"]>;

const decodeNameSubsection = (
  names: ComponentNames,
  id: number,
  sub: WasmComponentReader,
): void => {
  if (id === 0) {
    names.component = sub.name("component name");
    sub.expectEnd("component name subsection");
    return;
  }
  if (id !== 1) return;
  const sort = decodeSort(sub, { scopes: [], features: new Set(), depth: 0 });
  const entries: { index: number; name: string }[] = [];
  const count = sub.count("name map");
  for (let index = 0; index < count; index += 1)
    entries.push({
      index: sub.u32("named index"),
      name: sub.name("index name"),
    });
  sub.expectEnd("sort name subsection");
  names.sorts.push({ sort, names: entries });
};

/**
 * Record one custom section, decoding `component-name` when present. An
 * invalid name section never rejects the component; names decoded before the
 * failure are kept, and the failure is returned for coverage.
 */
export const decodeCustomSection = (
  component: DecodedComponent,
  reader: WasmComponentReader,
): WasmComponentFormatFailure | null => {
  const range = { start: reader.offset, end: reader.end };
  const name = reader.name("custom section name");
  component.custom_sections.push({ name, range });
  if (name !== COMPONENT_NAME) return null;
  const names: ComponentNames = {
    range,
    status: "decoded",
    reason: null,
    component: null,
    sorts: [],
  };
  component.names = names;
  try {
    while (!reader.atEnd) {
      const id = reader.byte("name subsection id");
      const size = reader.u32("name subsection size");
      decodeNameSubsection(names, id, reader.sub(size, "name subsection"));
    }
  } catch (cause: unknown) {
    if (!isWasmComponentFormatFailure(cause)) throw cause;
    names.status = "invalid";
    names.reason = cause.message;
    return cause;
  }
  return null;
};
