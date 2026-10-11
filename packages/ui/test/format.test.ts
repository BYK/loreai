import { describe, expect, it } from "vitest";

import { formatActivityTime, formatWhen } from "~/lib/format";

// Local-time constructors so the calendar-day bucketing is exercised in
// whatever zone the test host runs in.
const local = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("formatWhen", () => {
  const now = new Date(local(2026, 9, 14, 1, 0)); // Monday 01:00

  it("renders unknown timestamps as a dash", () => {
    expect(formatWhen(null, now)).toBe("—");
    expect(formatWhen(0, now)).toBe("—");
    expect(formatWhen(undefined, now)).toBe("—");
  });

  it("says 'today at' for anything on today's calendar date", () => {
    expect(formatWhen(local(2026, 9, 14, 0, 5), now)).toBe("today at 12:05 AM");
  });

  it("says yesterday only for the previous calendar day, not for < 48 h ago", () => {
    // Sunday 23:00 — two hours ago, but a different calendar day.
    expect(formatWhen(local(2026, 9, 13, 23, 0), now)).toBe(
      "yesterday at 11:00 PM",
    );
    // Sunday 02:00 — 23 h ago, still yesterday.
    expect(formatWhen(local(2026, 9, 13, 2, 0), now)).toBe(
      "yesterday at 2:00 AM",
    );
    // Saturday 23:00 — 26 h ago, two calendar days back.
    expect(formatWhen(local(2026, 9, 12, 23, 0), now)).toBe(
      "last Saturday at 11:00 PM",
    );
  });

  it("uses the weekday for 2-6 calendar days ago and a date beyond that", () => {
    expect(formatWhen(local(2026, 9, 8, 23, 0), now)).toBe(
      "last Tuesday at 11:00 PM",
    );
    expect(formatWhen(local(2026, 9, 7, 12, 0), now)).toBe("09/07/2026");
    expect(formatWhen(local(2025, 9, 7), now)).toBe("09/07/2025");
  });

  it("never labels a future timestamp yesterday or with a past weekday", () => {
    // Clock skew between gateway and browser: tomorrow 00:30.
    expect(formatWhen(local(2026, 9, 15, 0, 30), now)).toBe(
      "tomorrow at 12:30 AM",
    );
  });
});

describe("formatActivityTime", () => {
  const now = local(2026, 10, 14, 1, 0);

  it("uses minutes, hours, days, and a short date at the requested boundaries", () => {
    expect(formatActivityTime(now - 59_999, now)).toBe("just now");
    expect(formatActivityTime(now - 60_000, now)).toBe("1 minute ago");
    expect(formatActivityTime(now - 60 * 60_000, now)).toBe("1 hour ago");
    expect(formatActivityTime(now - 24 * 60 * 60_000, now)).toBe("1 day ago");
    expect(formatActivityTime(now - 7 * 24 * 60 * 60_000, now)).toBe("Oct 7");
    expect(formatActivityTime(local(2025, 10, 7), now)).toBe("Oct 7, 2025");
  });

  it("uses relative wording for future timestamps and handles unknown values", () => {
    expect(formatActivityTime(null, now)).toBe("—");
    expect(formatActivityTime(now + 60_000, now)).toBe("in 1 minute");
  });
});
