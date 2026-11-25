/**
 * ISO 9660 dates. Directory records use a 7-byte binary form; volume
 * descriptors use sixteen ASCII digits. Both end with a signed offset from
 * UTC in 15-minute units. Unrecorded or out-of-range dates are `null`.
 */

interface Clock {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const pad = (value: number): string => String(value).padStart(2, "0");

const utcOffset = (quarterHours: number): string | null => {
  if (quarterHours < -48 || quarterHours > 52) return null;
  const minutes = Math.abs(quarterHours) * 15;
  return `${quarterHours < 0 ? "-" : "+"}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
};

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

const leapYear = (year: number): boolean =>
  year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const daysInMonth = (year: number, month: number): number =>
  month === 2 && leapYear(year) ? 29 : MONTH_DAYS[month - 1]!;

const validClock = ({
  year,
  month,
  day,
  hour,
  minute,
  second,
}: Clock): boolean =>
  month >= 1 &&
  month <= 12 &&
  day >= 1 &&
  day <= daysInMonth(year, month) &&
  hour <= 23 &&
  minute <= 59 &&
  second <= 59;

const signedByte = (bytes: Uint8Array, at: number): number => {
  const value = bytes[at] ?? 0;
  return value > 0x7f ? value - 0x100 : value;
};

/**
 * A 7-byte directory record date. All-zero dates are unrecorded; an
 * out-of-range field leaves the date unknown rather than invalidating the
 * record.
 */
export const decodeIso9660RecordDate = (
  bytes: Uint8Array,
  at: number,
): string | null => {
  const fields = Array.from(bytes.subarray(at, at + 6));
  if (fields.every((value) => value === 0)) return null;
  const [years = 0, month = 0, day = 0, hour = 0, minute = 0, second = 0] =
    fields;
  const year = 1900 + years;
  const offset = utcOffset(signedByte(bytes, at + 6));
  if (
    offset === null ||
    !validClock({ year, month, day, hour, minute, second })
  )
    return null;
  return `${String(year)}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${offset}`;
};

/**
 * A 17-byte volume descriptor date: sixteen ASCII digits and a signed
 * offset in 15-minute units. All-zero digits are unrecorded.
 */
export const decodeIso9660VolumeDate = (
  bytes: Uint8Array,
  at: number,
): string | null => {
  const digits = Buffer.from(bytes.subarray(at, at + 16)).toString("latin1");
  if (!/^\d{16}$/u.test(digits) || /^0{16}$/u.test(digits)) return null;
  const field = (start: number): string => digits.slice(start, start + 2);
  const offset = utcOffset(signedByte(bytes, at + 16));
  const clock = {
    year: Number(digits.slice(0, 4)),
    month: Number(field(4)),
    day: Number(field(6)),
    hour: Number(field(8)),
    minute: Number(field(10)),
    second: Number(field(12)),
  };
  if (offset === null || !validClock(clock)) return null;
  return `${digits.slice(0, 4)}-${field(4)}-${field(6)}T${field(8)}:${field(10)}:${field(12)}.${field(14)}${offset}`;
};
