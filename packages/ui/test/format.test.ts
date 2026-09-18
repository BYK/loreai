import { describe, expect, it } from "vitest";

import { formatWhen } from "~/lib/format";

// Local-time constructors so the calendar-day maths is exercised in whatever
// zone the test host runs in.
const local = (y: number, m: number, d: number, h = 12, min = 0) =>
  new Date(y, m - 1, d, h, min).getTime();

describe("formatWhen", () => {
  const now = new Date(local(2026, 9, 14, 1, 0)); // Monday 01:00

  it("renders unknown timestamps as a dash", () => {
    expect(formatWhen(null, now)).toBe("—");
    expect(formatWhen(0, now)).toBe("—");
    expect(formatWhen(undefined, now)).toBe("—");
  });

  it("shows the time of day for anything on today's calendar date", () => {
    const midnight = new Date(local(2026, 9, 14, 0, 5));
    expect(formatWhen(midnight.getTime(), now)).toBe(
      midnight.toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    );
  });

  it("says Yesterday only for the previous calendar day, not for < 48 h ago", () => {
    // Sunday 23:00 — two hours ago, but a different calendar day.
    expect(formatWhen(local(2026, 9, 13, 23, 0), now)).toBe("Yesterday");
    // Sunday 02:00 — 23 h ago, still yesterday.
    expect(formatWhen(local(2026, 9, 13, 2, 0), now)).toBe("Yesterday");
    // Saturday 23:00 — 26 h ago; the old `< 2 days` check called this Yesterday.
    expect(formatWhen(local(2026, 9, 12, 23, 0), now)).toBe(
      new Date(local(2026, 9, 12, 23, 0)).toLocaleDateString(undefined, {
        weekday: "long",
      }),
    );
  });

  it("uses the weekday for 2-6 calendar days ago and a date beyond that", () => {
    const sixDays = new Date(local(2026, 9, 8, 23, 0));
    expect(formatWhen(sixDays.getTime(), now)).toBe(
      sixDays.toLocaleDateString(undefined, { weekday: "long" }),
    );
    const sevenDays = new Date(local(2026, 9, 7, 12, 0));
    expect(formatWhen(sevenDays.getTime(), now)).toBe(
      sevenDays.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
    const lastYear = new Date(local(2025, 9, 7));
    expect(formatWhen(lastYear.getTime(), now)).toBe(
      lastYear.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      }),
    );
  });

  it("never labels a future timestamp Yesterday or with a weekday", () => {
    // Clock skew between gateway and browser: tomorrow 00:30.
    const tomorrow = new Date(local(2026, 9, 15, 0, 30));
    expect(formatWhen(tomorrow.getTime(), now)).toBe(
      tomorrow.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
    );
  });
});
