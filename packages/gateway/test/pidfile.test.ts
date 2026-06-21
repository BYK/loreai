import { describe, it, expect, afterEach } from "vitest";
import {
  writePidFile,
  readPidFile,
  removePidFile,
  isProcessAlive,
} from "../src/pidfile";

// Clean up any pid file we wrote during tests.
afterEach(() => {
  try {
    writePidFile(999999);
    removePidFile(999999);
  } catch {
    /* best effort */
  }
});

describe("pidfile", () => {
  it("readPidFile returns null when no file exists", () => {
    writePidFile(999999);
    removePidFile(999999);
    expect(readPidFile()).toBeNull();
  });

  it("writePidFile + readPidFile round-trips a pid", () => {
    writePidFile(4242);
    expect(readPidFile()).toBe(4242);
  });

  it("writePidFile overwrites an existing pid file", () => {
    writePidFile(4242);
    writePidFile(5353);
    expect(readPidFile()).toBe(5353);
  });

  it("removePidFile deletes the file when pid matches", () => {
    writePidFile(4242);
    removePidFile(4242);
    expect(readPidFile()).toBeNull();
  });

  it("removePidFile does NOT delete the file when pid differs", () => {
    writePidFile(5353);
    removePidFile(4242); // wrong pid — should not remove
    expect(readPidFile()).toBe(5353);
  });

  it("removePidFile is a no-op when no file exists", () => {
    removePidFile(4242);
    expect(readPidFile()).toBeNull();
  });

  it("readPidFile rejects invalid content", () => {
    writePidFile(0);
    expect(readPidFile()).toBeNull();
    writePidFile(-5);
    expect(readPidFile()).toBeNull();
  });

  it("isProcessAlive returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  it("isProcessAlive returns false for a non-existent pid", () => {
    // PID 2^31-1 is effectively never a live process.
    expect(isProcessAlive(2147483646)).toBe(false);
  });
});
