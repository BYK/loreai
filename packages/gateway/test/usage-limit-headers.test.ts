import { expect, it } from "vitest";
import { copyUsageLimitHeaders } from "../src/usage-limit-headers";

it("copies only quota namespaces and excludes Connection-nominated fields", () => {
  const source = new Headers({
    "X-RateLimit-Remaining-Tokens": "99",
    "x-codex-bengalfox-secondary-used-percent": "80",
    "x-codex-credits-balance": "10.25",
    connection:
      "keep-alive, X-RateLimit-Reset-Tokens, X-Codex-Primary-Used-Percent",
    "x-ratelimit-reset-tokens": "2s",
    "x-codex-primary-used-percent": "12.5",
    "set-cookie": "private=secret",
    authorization: "Bearer secret",
    "x-codex-session-id": "private-session",
    "x-codex-credits-secret": "private-credit",
    "x-private-limit-name": "not-a-metered-bucket",
    "x-ratelimitish-secret": "private-prefix",
    "content-length": "99999",
    "content-encoding": "gzip",
  });
  const target = new Headers({ "content-type": "application/json" });
  copyUsageLimitHeaders(source, target);
  expect(Object.fromEntries(target)).toEqual({
    "content-type": "application/json",
    "x-ratelimit-remaining-tokens": "99",
    "x-codex-bengalfox-secondary-used-percent": "80",
    "x-codex-credits-balance": "10.25",
  });
  expect(source.get("set-cookie")).toBe("private=secret");
});
