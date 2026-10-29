/** Numeric admission contracts shared by environment parsing and runtime tools.
 * Timer maxima follow signed 32-bit scheduling. ASAR's 256 MiB maximum and
 * worker 16 GiB maxima are REA policies, not claims about format/host capacity.
 * Regex's 7 MiB floor is measured; decoder's 8 MiB floor matches its semi-space.
 */
/** Header/index bytes admitted when the setting is unset. */
export const DEFAULT_ASAR_MAX_HEADER_BYTES = 16 * 1024 * 1024;

/**
 * Largest configurable admission. The header JSON is decoded into one string
 * and parsed in memory; 256 MiB keeps that text and its parse copy well below
 * Node's single-string ceiling of about 512 Mi UTF-16 code units. A lower value
 * only refuses more archives, so the setting has no floor.
 */
export const MAXIMUM_ASAR_MAX_HEADER_BYTES = 256 * 1024 * 1024;

/** Native function-matching representation admitted when the setting is unset. */
export const DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES = 96 * 1024 * 1024;

/**
 * Largest configurable matching admission. This is an REA policy ceiling, not
 * a claim about host capacity: the allowance approximates the heap
 * representation matching retains, and peak heap during a request can exceed
 * it. A lower value only refuses more requests, so the setting has no floor.
 */
export const MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES = 1024 * 1024 * 1024;

/** Default absolute deadline for Ghidra import, analysis, bridge, and readiness. */
export const DEFAULT_GHIDRA_STARTUP_TIMEOUT_MS = 330_000;

/** Default absolute deadline for Hopper launch, analysis, bridge, and readiness. */
export const DEFAULT_HOPPER_STARTUP_TIMEOUT_MS = 120_000;

/**
 * Largest delay Node schedules exactly. Delays above this signed 32-bit
 * boundary become a 1 ms timer, so startup and swiftc timeouts stop here.
 */
export const MAX_PROVIDER_STARTUP_TIMEOUT_MS = 2_147_483_647;

/**
 * Ghidra 12.1.4 converts whole seconds to a signed int millisecond delay.
 * Keep that multiplication positive and exact rather than imposing a day cap.
 */
export const MAX_GHIDRA_DECOMPILE_TIMEOUT_SECONDS = Math.floor(
  MAX_PROVIDER_STARTUP_TIMEOUT_MS / 1000,
);

/** Matching deadline used when the setting is unset. Today's fixed constant. */
export const DEFAULT_REGEX_MATCHING_DEADLINE_MS = 5_000;

/**
 * Largest delay Node schedules exactly. A `setTimeout` delay above this
 * signed 32-bit bound is clamped to 1 ms, so a matching deadline past it
 * would expire immediately. The setting stops here instead of growing
 * without a bound. The floor is 1 ms: zero and negative values are not a
 * deadline.
 */
export const MAXIMUM_REGEX_MATCHING_DEADLINE_MS = 2_147_483_647;

/** Worker old-generation request used when the setting is unset. Today's constant. */
export const DEFAULT_REGEX_WORKER_HEAP_REQUEST_MIB = 128;

/**
 * Smallest request that completes a trivial regex match on supported Node.
 * Linux runs of the production worker (`^a` against `["a"]`, no
 * `NODE_OPTIONS`) return `ERR_WORKER_OUT_OF_MEMORY` at 6 MiB on Node 24.21.0
 * and 24.22.1, and on most runs of 24.11.0, 24.18.0, and 26.0.0. 7 MiB
 * returned that match on Node 22.19.0, 22.23.4, 24.11.0, 24.18.0, 24.21.0,
 * 24.22.1, 26.0.0, and 26.12.1. A lower accepted value passes configuration
 * and then fails the search.
 */
export const MINIMUM_REGEX_WORKER_HEAP_REQUEST_MIB = 7;

/**
 * Largest request one regex worker may make. 16 GiB is the same ceiling REA
 * already uses for an isolated JavaScript analysis worker. A positive Node
 * `--max-old-space-size` can still set a different effective heap; this
 * maximum bounds only the REA request.
 */
export const MAXIMUM_REGEX_WORKER_HEAP_REQUEST_MIB = 16_384;

/** Old-generation mebibytes used when the setting is unset. Today's constant. */
export const DEFAULT_CAPTURE_DECODER_OLD_GENERATION_MIB = 192;

/**
 * Semi-space the owned decoder always passes. It is not a setting. An old
 * generation smaller than this semi-space aborts Node during isolate startup
 * instead of enforcing a heap limit, so the setting's floor is this value.
 */
export const CAPTURE_DECODER_SEMI_SPACE_MIB = 8;

/**
 * Largest old generation one owned decoder may request. 16 GiB is the same
 * ceiling REA already uses for an isolated JavaScript analysis worker. Node
 * will start with a larger flag; this maximum is REA's refusal, so one
 * decoder cannot ask for an unbounded old generation.
 */
export const MAXIMUM_CAPTURE_DECODER_OLD_GENERATION_MIB = 16_384;
export const DEFAULT_JADX_OPERATION_TIMEOUT_MS = 120_000;
