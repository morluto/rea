# Raw raster preview exploratory MVP

Status: experimental proposal for [#8162](https://github.com/morluto/rea/issues/8162).
Maintainer scope, provider ownership and artifact/subject identity decisions are
pending. This specification does not authorize provider integration or imply
production readiness; see [contribution scope](https://github.com/morluto/rea/blob/main/CONTRIBUTING.md#contribution-scope).

## Problem and outcome

An analyst who knows the layout of headerless pixels should be able to inspect
them without writing a project-specific decoder. This first increment explores
the reusable decoding boundary and a PNG preview, not a public CLI or MCP tool.

## Requirements

- R1: Decode `gray8`, `rgb888`, `bgr888`, `rgba8888` and `bgra8888` into
  top-down, straight-alpha RGBA8. Preserve 8-bit samples exactly; synthesize opaque
  alpha only for formats without alpha. Premultiplied alpha is not supported.
- R2: Require explicit `offset`, `length`, `width`, `height`, `stride` and
  `rowOrder` (`top-down` or `bottom-up`). Preserve the selected range even when it
  includes padding or trailing bytes. Final-row padding need not be present.
- R3: Reject invalid integers, unsafe arithmetic, unsupported layouts,
  out-of-range or truncated selections and short strides before allocating the
  RGBA output. Admit input bytes and output pixels against caller-supplied
  resource allowances. The decoder must not mutate its input.
- R4: Keep PNG encoding and I/O outside the decoding core. An experimental
  preview manifest records the complete selected range's SHA-256, layout,
  consumed span and PNG SHA-256. Those hashes identify preview inputs and output,
  **not** a REA artifact or subject identity or a verified stable source file.
- R5: Do not register a provider, CLI command, MCP tool or runtime setting in this
  increment. The experiment neither executes targets nor modifies source files.

## Acceptance and non-goals

Synthetic checks should cover exact pixels for every format, row direction,
padding, nonzero offsets, truncated input, invalid layouts and resource bounds.
PNG verification should independently decode a tiny fixture and compare pixels;
source and selection hashes should distinguish padding changes from pixel changes.
These are intended checks, not a record of executed verification.

Automatic detection, compression/container parsing, indexed and sub-byte formats,
16-bit channels, color management, tiled/GPU textures and bitmap-font layout are
out of scope. Production file acquisition, source stability, cancellation,
Evidence provenance and public CLI/MCP workflows remain future integration work.

See [implementation plan](plan.md) and [tasks](tasks.md).
