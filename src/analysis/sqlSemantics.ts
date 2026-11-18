/**
 * Postgres semantics that the Starkeep and mock DataLayers reproduce in
 * TypeScript: `timestamptz` parsing at microsecond precision, and `text`
 * ordering under the database's `en_US` collation.
 */

/** `Date.UTC` without its mapping of years 0-99 to 1900-1999. */
function utcMs(year: number, month: number, day: number, h = 0, mi = 0, s = 0): number {
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day);
  d.setUTCHours(h, mi, s, 0);
  return d.getTime();
}

/**
 * Parses a `timestamptz` text value to exact microseconds since the epoch.
 * Postgres stores microsecond precision, which `Date.parse` would truncate.
 * A value without an offset is taken as UTC, Supabase's session TimeZone.
 */
export function timestampMicros(ts: string): bigint {
  const m =
    /^(\d{4,})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(Z|[+-]\d{2}(?::?\d{2}(?::?\d{2})?)?)?$/i.exec(
      ts.trim(),
    );
  if (!m) {
    const ms = Date.parse(ts);
    if (Number.isNaN(ms)) throw new Error(`invalid timestamptz: ${ts}`);
    return BigInt(ms) * 1000n;
  }
  const [, y, mo, d, h = "0", mi = "0", s = "0", frac = "", zone = "Z"] = m;
  const ms = utcMs(Number(y), Number(mo), Number(d), Number(h), Number(mi), Number(s));
  // Postgres rounds input beyond microseconds to the nearest microsecond (half up).
  const digits = frac.padEnd(7, "0").slice(0, 7);
  const fracMicros = (BigInt(digits) + 5n) / 10n;
  let micros = BigInt(ms) * 1000n + fracMicros;
  if (zone.toUpperCase() !== "Z") {
    const zm = /^([+-])(\d{2}):?(\d{2})?:?(\d{2})?$/.exec(zone)!;
    const offsetSeconds = Number(zm[2]) * 3600 + Number(zm[3] ?? 0) * 60 + Number(zm[4] ?? 0);
    micros -= BigInt((zm[1] === "-" ? -1 : 1) * offsetSeconds) * 1_000_000n;
  }
  return micros;
}

const textCollator = new Intl.Collator("en-US");

/**
 * `text` ordering under the database's default collation, assumed to be
 * `en_US.UTF-8` (Supabase's default). Approximated with ICU's `en-US`
 * collator, which agrees with glibc for letters, digits and case but can
 * differ for punctuation and whitespace. Like Postgres with a deterministic
 * collation, strings the collation ranks equal are tie-broken by code point.
 */
export function compareText(a: string, b: string): number {
  const c = textCollator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}
