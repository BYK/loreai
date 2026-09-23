import { test } from "vitest";

test("writes more output than the parent retains", () => {
  const output = "x".repeat(512 * 1024);
  process.stdout.write(output);
  process.stderr.write(output);
});
