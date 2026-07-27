/**
 * Byte-driven TTY progress bar for long-running CLI operations.
 *
 * Design contract (shared with the sync progress reporter):
 * - Renders only on a TTY; a no-op otherwise (header may still print once).
 * - Cosmetic ONLY — rendering must never throw or abort the underlying work.
 * - Determinate: caller supplies a byte `total`; progress advances by reported
 *   bytes written/downloaded. When `total` is unknown, an indeterminate form
 *   (byte counter, no bar) is used.
 *
 * One line, redrawn in place via carriage return; `done()` clears the line so
 * the next message prints cleanly.
 */

export type ByteProgressOut = {
  isTTY?: boolean;
  write: (s: string) => unknown;
};

export type ByteProgress = {
  /** Report `bytes` additional bytes processed since the last call. */
  onProgress: (bytes: number) => void;
  /** Clear the progress line (call before printing the next message). */
  done: () => void;
};

const BAR_WIDTH = 16;

function renderBar(frac: number, width = BAR_WIDTH): string {
  const filled = Math.max(0, Math.min(width, Math.round(width * frac)));
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2)} ${units[u]}`;
}

/**
 * Create a byte-progress bar.
 *
 * @param label - Short label shown before the bar (e.g. "Applying 3 patches").
 * @param totalBytes - Expected total bytes; `null` renders an indeterminate
 *   byte counter instead of a bar.
 * @param out - Output stream (defaults to stderr, the CLI's progress channel).
 * @param format - `"bytes"` (default) renders the accumulated/total byte
 *   count. `"pct"` renders only the percentage — useful when the byte
 *   total is misleading (e.g. a multi-hop chain where intermediate hops
 *   inflate the displayed size beyond the actual final binary).
 */
export function makeByteProgress(
  label: string,
  totalBytes: number | null,
  out: ByteProgressOut = process.stderr,
  format: "bytes" | "pct" = "bytes",
): ByteProgress {
  const tty = !!out.isTTY;
  let written = 0;
  let lastLen = 0;
  let headerShown = false;

  const line = (): string => {
    if (totalBytes === null || totalBytes <= 0) {
      return `${label}  ${formatBytes(written)}`;
    }
    const frac = Math.min(written / totalBytes, 1);
    if (format === "pct") {
      return `${label} [${renderBar(frac)}] ${(frac * 100).toFixed(0)}%`;
    }
    return (
      `${label} [${renderBar(frac)}] ` +
      `${formatBytes(written)} / ${formatBytes(totalBytes)}`
    );
  };

  const onProgress = (bytes: number): void => {
    // Cosmetic only — a rendering failure must never abort the operation.
    try {
      written += bytes;
      if (!tty) {
        if (!headerShown) {
          out.write(`${label}\n`);
          headerShown = true;
        }
        return;
      }
      const l = line();
      lastLen = l.length;
      out.write(`\r${l}`);
    } catch {
      // ignore — progress is cosmetic
    }
  };

  const done = (): void => {
    // Cosmetic only — must never throw, matching onProgress's contract.
    try {
      if (tty && lastLen > 0) out.write(`\r${" ".repeat(lastLen)}\r`);
    } catch {
      // ignore — progress is cosmetic
    }
  };

  return { onProgress, done };
}
