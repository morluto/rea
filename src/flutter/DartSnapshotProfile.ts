import {
  readElfSymbols,
  readSnapshotHeader,
  type ElfSymbol,
} from "./DartElf.js";

const LEGACY = {
  name: "legacy-split",
  data: ["_kDartVmSnapshotData", "_kDartIsolateSnapshotData"],
  text: ["_kDartVmSnapshotInstructions", "_kDartIsolateSnapshotInstructions"],
  pool: "_kDartIsolateSnapshotData",
  kind: 3,
} as const;
const UNIFIED = {
  name: "unified",
  data: ["_kDartSnapshotData"],
  text: ["_kDartSnapshotText"],
  pool: "_kDartSnapshotData",
  kind: 2,
} as const;

type Profile = typeof LEGACY | typeof UNIFIED;
type Header = ReturnType<typeof readSnapshotHeader>;
const ALL_SYMBOLS = [
  ...LEGACY.data,
  ...LEGACY.text,
  ...UNIFIED.data,
  ...UNIFIED.text,
];
const DATA_SYMBOLS: ReadonlySet<string> = new Set([
  ...LEGACY.data,
  ...UNIFIED.data,
]);

const overlap = (a: ElfSymbol, b: ElfSymbol): boolean =>
  a.offset < b.offset + b.size && b.offset < a.offset + a.size;

const sameRange = (
  alias: ElfSymbol,
  canonical: ElfSymbol | undefined,
): boolean =>
  canonical !== undefined &&
  alias.offset === canonical.offset &&
  alias.size === canonical.size;

const profileFacts = (
  profile: Profile,
  symbols: ReadonlyMap<string, ElfSymbol>,
  headers: ReadonlyMap<string, Header>,
) => {
  const names: readonly string[] = [...profile.data, ...profile.text];
  const present = names.flatMap((name) => symbols.get(name) ?? []);
  const data = profile.data.flatMap((name) => {
    const symbol = symbols.get(name);
    const header = headers.get(name);
    return symbol !== undefined && header !== undefined
      ? [{ symbol, header }]
      : [];
  });
  const validData = data.filter(
    ({ header }) => header.complete && header.kind === profile.kind,
  );
  const text = profile.text.map((name) => symbols.get(name));
  const aliased = data.some(({ symbol }, index) =>
    data
      .slice(0, index)
      .some((previous) => previous.symbol.offset === symbol.offset),
  );
  const overlapping = data.some(({ symbol }, index) =>
    data.slice(0, index).some((previous) => overlap(previous.symbol, symbol)),
  );
  const textOverlapsData =
    profile === UNIFIED &&
    text.some(
      (symbol) =>
        symbol !== undefined &&
        data.some((entry) => overlap(entry.symbol, symbol)),
    );
  return {
    profile,
    names,
    present,
    data,
    qualified: validData.length > 0,
    complete:
      validData.length === profile.data.length &&
      text.every((symbol) => symbol !== undefined && symbol.size > 0) &&
      !overlapping &&
      !textOverlapsData,
    aliased,
    overlapping,
    textOverlapsData,
  };
};

/** One inventory owns the layout, extent and physical hash provenance for the report. */
export const observeDartSnapshot = async (
  bytes: Buffer,
  signal?: AbortSignal,
) => {
  const inventory = await readElfSymbols(bytes, ALL_SYMBOLS, signal);
  if (inventory.symbols.length === 0)
    return {
      observed: false as const,
      reasons: inventory.failures.map(({ reason }) => reason),
    };

  const symbols = new Map(
    inventory.symbols.map((symbol) => [symbol.name, symbol]),
  );
  const headers = new Map<string, Header>();
  const physicalHeaders = new Map<string, Header>();
  const hashes = new Map<number, string>();
  const sections = inventory.symbols.map(({ name, offset, size }) => {
    let header: Header | undefined;
    if (DATA_SYMBOLS.has(name)) {
      const range = `${offset}:${size}`;
      header =
        physicalHeaders.get(range) ??
        readSnapshotHeader(bytes.subarray(offset, offset + size), 0);
      physicalHeaders.set(range, header);
      headers.set(name, header);
      if (header.hash !== null) hashes.set(offset, header.hash);
    }
    return {
      name,
      offset,
      size,
      magic_valid: header?.magicValid ?? false,
      kind: header?.kind ?? null,
      header_length: header?.headerLength ?? null,
    };
  });
  const candidates = [...new Set(hashes.values())];
  const legacy = profileFacts(LEGACY, symbols, headers);
  const unified = profileFacts(UNIFIED, symbols, headers);
  const mixed = legacy.present.length > 0 && unified.present.length > 0;
  // The transition assembler publishes both older names for each canonical role.
  const aliases =
    mixed &&
    unified.qualified &&
    legacy.present.every((symbol) =>
      sameRange(
        symbol,
        symbols.get(
          DATA_SYMBOLS.has(symbol.name) ? UNIFIED.data[0] : UNIFIED.text[0],
        ),
      ),
    );
  let selected: typeof legacy | null = null;
  if (!mixed) selected = legacy.present.length > 0 ? legacy : unified;
  else if (aliases) selected = unified;
  else if (legacy.complete && unified.data.length === 0) selected = legacy;
  else if (unified.complete && legacy.data.length === 0) selected = unified;
  const failures = inventory.failures.filter(
    ({ missingSymbol }) =>
      missingSymbol === undefined ||
      selected?.names.includes(missingSymbol) === true,
  );
  const limitations = failures.map(({ reason }) => reason);
  if (mixed && !aliases)
    limitations.push(
      selected === null
        ? "The legacy and unified exports do not establish one snapshot profile or string-pool source."
        : "Additional snapshot exports have no verified alias to the selected profile.",
    );
  if (aliases)
    limitations.push(
      "Legacy exports alias the unified text or data ranges. Each physical header counts once.",
    );
  if (selected !== null) {
    const {
      profile,
      present,
      names,
      data,
      aliased,
      overlapping,
      textOverlapsData,
    } = selected;
    if (present.length < names.length)
      limitations.push(
        `Only ${present.length} of ${names.length} snapshot symbols were present`,
      );
    if (aliased)
      limitations.push(
        "Two or more snapshot data symbols share one header offset; its hash counts as one source instead of two agreeing ones",
      );
    else if (overlapping)
      limitations.push(
        "Snapshot data symbol ranges overlap; independent VM/isolate coverage is not established",
      );
    if (textOverlapsData)
      limitations.push("Unified snapshot text and data symbol ranges overlap.");
    for (const { symbol, header } of data)
      if (!header.complete || header.kind !== profile.kind)
        limitations.push(
          `${symbol.name} has an incomplete or invalid snapshot header: kind ${String(header.kind)} (AOT app requires ${profile.kind}), declared length ${String(header.headerLength)} excludes the four magic bytes, symbol size ${symbol.size}, valid hash ${String(header.hash !== null)}`,
        );
  }
  const pool =
    selected === null ? undefined : symbols.get(selected.profile.pool);
  return {
    observed: true as const,
    profile: selected?.qualified === true ? selected.profile.name : null,
    pool:
      pool === undefined
        ? null
        : bytes.subarray(pool.offset, pool.offset + pool.size),
    complete:
      selected?.complete === true &&
      (!mixed || aliases) &&
      failures.length === 0 &&
      candidates.length === 1 &&
      hashes.size === selected.profile.data.length,
    sections,
    hashes: { candidates, sources: hashes.size },
    limitations,
  };
};
