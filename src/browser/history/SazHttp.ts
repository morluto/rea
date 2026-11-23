import { CaptureFormatError } from "./CaptureFormatError.js";

/** Locate the first blank line ending headers across CRLF, LF, or mixed line endings. */
const findHeaderBoundary = (
  bytes: Buffer,
): { readonly headerEnd: number; readonly bodyStart: number } | null => {
  let offset = 0;
  while (offset < bytes.length) {
    const lf = bytes.indexOf(0x0a, offset);
    if (lf < 0) return null;
    const next = lf + 1;
    const blankLineLength =
      bytes[next] === 0x0a
        ? 1
        : bytes[next] === 0x0d && bytes[next + 1] === 0x0a
          ? 2
          : 0;
    if (blankLineLength > 0)
      return {
        headerEnd: lf > 0 && bytes[lf - 1] === 0x0d ? lf - 1 : lf,
        bodyStart: next + blankLineLength,
      };
    offset = next;
  }
  return null;
};

/** Preserve ordered HTTP fields and the stored body; never dechunk, decompress or fetch. */
export const decodeSazHttp = (bytes: Buffer, request: boolean) => {
  // The first blank line ends the headers. Later separators belong to the
  // stored body, which may use different line endings or contain binary data.
  const boundary = findHeaderBoundary(bytes);
  if (boundary === null)
    throw new CaptureFormatError(
      "malformed",
      "SAZ HTTP message has no header/body separator.",
    );
  const parts = bytes
    .subarray(0, boundary.headerEnd)
    .toString("latin1")
    .split(/(\r?\n)/);
  const first = parts[0] ?? "";
  const fields = request
    ? /^(\S+) +(\S+) +(HTTP\/\d+(?:\.\d+)?)$/.exec(first)
    : /^(HTTP\/\d+(?:\.\d+)?) +(\d{3})(?: (.*))?$/.exec(first);
  if (fields === null)
    throw new CaptureFormatError(
      "malformed",
      "SAZ HTTP start line is malformed.",
    );
  const headers: { name: string; value: string }[] = [];
  for (let index = 2; index < parts.length; index += 2) {
    const line = parts[index] ?? "";
    if (/^[ \t]/.test(line)) {
      const previous = headers.at(-1);
      if (previous === undefined)
        throw new CaptureFormatError(
          "malformed",
          "SAZ HTTP header continuation has no field.",
        );
      previous.value += `${parts[index - 1] ?? ""}${line}`;
      continue;
    }
    const colon = line.indexOf(":");
    // HTTP/2 pseudo-headers use the second colon as the delimiter.
    const delimiter = colon === 0 ? line.indexOf(":", 1) : colon;
    if (delimiter < 1)
      throw new CaptureFormatError(
        "malformed",
        "SAZ HTTP header is malformed.",
      );
    const name = line.slice(0, delimiter);
    if (!/^:?[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name))
      throw new CaptureFormatError(
        "malformed",
        "SAZ HTTP header name is malformed.",
      );
    headers.push({ name, value: line.slice(delimiter + 1) });
  }
  const start = request
    ? {
        method: fields[1] ?? "",
        url: fields[2] ?? "",
        http_version: fields[3] ?? "",
      }
    : {
        http_version: fields[1] ?? "",
        status: fields[2] ?? "",
        reason: fields[3] ?? "",
      };
  return {
    ...start,
    headers,
    body: bytes.subarray(boundary.bodyStart),
  };
};
