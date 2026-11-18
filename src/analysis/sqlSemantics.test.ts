import { compareText, timestampMicros } from "./sqlSemantics.js";

describe("sqlSemantics", () => {
  it("timestamptz parsing keeps microseconds and offsets", () => {
    expect(timestampMicros("2026-08-01T00:00:00.000002+00:00") - timestampMicros("2026-08-01T00:00:00.000001Z")).toBe(1n);
    expect(timestampMicros("2026-08-01T02:00:00+02:00")).toBe(timestampMicros("2026-08-01T00:00:00Z"));
    expect(timestampMicros("2026-08-01 00:00:00+00")).toBe(timestampMicros("2026-08-01T00:00:00Z"));
    // input beyond microseconds rounds to the nearest microsecond
    expect(timestampMicros("2026-08-01T00:00:00.0000025Z") - timestampMicros("2026-08-01T00:00:00Z")).toBe(3n);
    expect(timestampMicros("2026-08-01T00:00:00.00000249Z") - timestampMicros("2026-08-01T00:00:00Z")).toBe(2n);
    // no 1900s mapping of years 0-99
    expect(timestampMicros("0050-01-02T00:00:00Z") - timestampMicros("0049-12-31T00:00:00Z")).toBe(2n * 86_400_000_000n);
  });

  it("text ordering follows en_US (case-insensitive first) then code point", () => {
    expect(compareText("bench", "Curl")).toBeLessThan(0);
    expect(compareText("Row", "row")).not.toBe(0);
  });
});
