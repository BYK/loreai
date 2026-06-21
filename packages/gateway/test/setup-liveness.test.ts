import { describe, it, expect } from "vitest";
import {
  chooseSetupPort,
  formatLivenessNotice,
  formatSetupGuidance,
} from "../src/cli/setup";

describe("chooseSetupPort", () => {
  it("returns undefined for the remote path (port is irrelevant)", () => {
    expect(
      chooseSetupPort({ remoteUrl: "http://remote:3207", livePort: 5673 }),
    ).toBeUndefined();
  });

  it("honors an explicit --port over a detected live port", () => {
    expect(chooseSetupPort({ explicitPort: 8080, livePort: 5673 })).toBe(8080);
  });

  it("uses a detected live gateway port when no explicit port is given", () => {
    // This is the fix for the 3207 → 5673 → random fallback mismatch.
    expect(chooseSetupPort({ livePort: 5673 })).toBe(5673);
  });

  it("returns undefined (→ default port) when nothing is detected", () => {
    expect(chooseSetupPort({ livePort: null })).toBeUndefined();
    expect(chooseSetupPort({})).toBeUndefined();
  });
});

describe("formatLivenessNotice", () => {
  it("reports OK when the gateway is reachable", () => {
    const r = formatLivenessNotice({
      alive: true,
      origin: "http://127.0.0.1:3207",
      remote: false,
    });
    expect(r.ok).toBe(true);
    expect(r.lines.join("\n")).toContain("http://127.0.0.1:3207");
  });

  it("warns with local remediation when a local gateway is down", () => {
    const r = formatLivenessNotice({
      alive: false,
      origin: "http://127.0.0.1:3207",
      remote: false,
    });
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("not reachable");
    expect(text).toContain("lore start --bg");
    expect(text).toContain("lore run");
  });

  it("warns without the local-start hint for a remote gateway", () => {
    const r = formatLivenessNotice({
      alive: false,
      origin: "http://remote:3207",
      remote: true,
    });
    expect(r.ok).toBe(false);
    const text = r.lines.join("\n");
    expect(text).toContain("not reachable");
    expect(text).not.toContain("lore start --bg");
  });
});

describe("formatSetupGuidance", () => {
  it("recommends `lore run` for terminal use and frames setup as the GUI/IDE path", () => {
    const text = formatSetupGuidance().join("\n");
    expect(text).toContain("lore run");
    expect(text).toContain("lore start --bg");
    expect(text.toLowerCase()).toContain("gui");
  });
});
