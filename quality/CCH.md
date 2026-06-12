# Reverse-Engineering Claude Code's `cch` Billing Hash

A field report on how we recovered Claude Code's `cch` request-signing hash,
fixed two compounding bugs that made our implementation produce wrong values,
and ended up identifying a non-canonical constant in Zig's standard library.

## TL;DR

The `cch` field in Claude Code's `x-anthropic-billing-header` is:

```
cch = xxHash64(serialized_body_with_cch=00000, seed) & 0xFFFFF   → 5-char lowercase hex
```

…but the xxHash64 is **Bun's / Zig std's variant**, which uses a
**non-canonical `PRIME64_4`**:

| Constant   | Canonical xxHash64    | Zig std / Bun (what Claude Code uses) |
| ---------- | --------------------- | ------------------------------------- |
| PRIME64_4  | `0x85ebca6b3b7b36ef`  | **`0x85ebca77c2b2ae63`**              |

Everything else (the other four primes, the round function, the finalization)
is stock xxHash64. The seed for recent versions is `0x4d659218e32a3268`.

Two bugs in our code compounded and masked each other:

1. **Wrong hash constant** — `packages/gateway/src/xxhash.ts` used the canonical
   `PRIME64_4`, so every `cch` we computed was wrong, even with the correct seed.
2. **Lossy oracle capture** — the seed extractor read the request body with
   `body += chunk`, which UTF-8-decodes each TCP chunk; a multibyte sequence
   split across a chunk boundary became `U+FFFD`, corrupting the bytes so no
   seed could ever validate.

Because extraction was broken (bug #2), we never noticed the seeds in the table
were correct and only the calculation (bug #1) was wrong.

## Why this was hard

The article ["What's `cch`?"](https://a10k.co/b/reverse-engineering-claude-code-cch.html)
documents the algorithm correctly but notes the authors tried "every common
hash… nothing matched," driving them to an LLDB memory-watchpoint approach. The
reason nothing matched: stock xxhash libraries use the canonical `PRIME64_4`.
Claude Code's hash *looks* like xxHash64 but is not bit-compatible with any
reference implementation — only with Zig std / Bun.

## The investigation, step by step

### 1. Symptom: extraction always returned NONE

`scripts/extract-cch-seed.ts` captured oracle pairs and scanned the 230 MB
binary for a seed reproducing them. It always found `NONE`, even for versions
whose seed was already in `VERSION_SEEDS` and demonstrably present in the binary.

### 2. Ruled out the obvious

Using oracle pairs captured from the local HTTP capture server:

- **Compression?** No — body is plain JSON (`content-type: application/json`).
- **Encoding round-trip?** The captured string re-encoded to identical bytes…
  *for bodies without chunk-split multibyte chars* (this hid bug #2 for a while).
- **Auth mode (api-key vs OAuth)?** Forced bearer mode with `ANTHROPIC_AUTH_TOKEN`
  — same failure.
- **Scan completeness/speed?** Wrote a native C scanner (`scripts/cch-scan.c`)
  doing a full 1-byte exhaustive scan in ~90s (vs a >30-min JS timeout). Still
  `NONE` with two byte-perfect pairs.

Conclusion at this stage: with byte-perfect bodies and an exhaustive scan, *no
seed in the binary* reproduced the wire body → either the body wasn't the hash
preimage, or the algorithm wasn't stock xxHash64.

### 3. Found the wire path (and an LD_PRELOAD dead end)

- `strace` showed the request leaves via `sendto(17, "POST /v1/messages…", 5112)`
  — a classic syscall (an earlier `io_uring_enter` sighting was unrelated
  background I/O).
- An `LD_PRELOAD` shim hooking `sendto`/`write`/`syscall` **never fired**: Bun's
  runtime makes **inline syscalls**, bypassing libc, so symbol interposition is
  defeated. (The shim's constructor *did* run, proving the `.so` loaded.)

### 4. ptrace at the syscall boundary

A small ptrace tracer caught the `sendto` syscall-stop and dumped `rsi[0..rdx]`
— the exact transmitted bytes. Even these byte-perfect wire bodies failed to
validate with the known seed. So the wire body was either not the preimage, or
the hash was non-standard.

### 5. Found the hash in the binary

Static search for the seed value `0x4d659218e32a3268` found a **single**
`movabs` site (runtime `0x2e06783`) — the cch hash, no decoy. Disassembly
showed standard xxHash64 init (`v1=seed+P1+P2`, `v3=seed`, `v4=seed−P1`),
`call`s to an update routine (`0x2ad99c0`) and a digest routine (`0x2917fe0`),
then `& 0xfffff` and hex-encode.

A ptrace **software breakpoint** (INT3, process-wide — survives the io_uring
"HTTP Client" thread, unlike per-thread hardware breakpoints) at the seed-init
instruction captured the **exact hash input** (`r14`=ptr, `r15`=len): a 4125-byte
body containing `cch=00000`, byte-identical before/after the update (no
mid-hash mutation).

### 6. Localized the divergence

Capturing the xxHash state accumulators **same-run** and replaying our
implementation offline:

- **After the bulk update** (4096 bytes): accumulators matched standard xxHash64
  exactly. → the update is stock.
- **After finalization**: diverged. → the bug is in the digest.

Disassembling the digest (`0x2917fe0`) revealed it loads its merge constant as:

```asm
movabs r8, 0x85ebca77c2b2ae63   ; standard PRIME64_4 is 0x85ebca6b3b7b36ef
```

Plugging `PRIME64_4 = 0x85ebca77c2b2ae63` into our finalization reproduced the
binary's digest **exactly** (`eax`, `cch`, and full 64-bit value all matched).

### 7. Confirmed against source

- **Bun**: `src/runtime/api/HashObject.zig` → `Bun.hash.xxHash64` wraps
  `std.hash.XxHash64.hash`.
- **Zig std**: `lib/std/hash/xxhash.zig` defines `prime_4 = 0x85EBCA77C2B2AE63`.

So it's not an Anthropic obfuscation tweak — it's a long-standing quirk in
Zig's stdlib (the value reuses byte-runs from PRIME64_1's `85ebca87` and
PRIME64_2's `c2b2ae`), inherited by Bun and therefore by Claude Code.

## The fix

1. **`packages/gateway/src/xxhash.ts`** — set `PRIME64_4 = 0x85ebca77c2b2ae63`,
   with a prominent comment so it is never "corrected" back. Added a
   known-answer regression test (`packages/gateway/test/xxhash.test.ts`).
2. **`scripts/cch-scan.c`** — native seed scanner using the same prime.
3. **`scripts/extract-cch-seed.ts`** — byte-safe oracle capture
   (`Buffer.concat` of raw chunks, byte-level `cch=00000` substitution; never
   `body += chunk`), `OraclePair.body` typed as `Uint8Array`, plus a
   known-seed fast path that validates before the (now-rarely-needed) scan.

## Verification

- Production `signBody()` reproduces the live binary's `cch` bit-for-bit
  (validated against bodies captured at the `sendto` syscall).
- The extractor validates the seed end-to-end for the first time:
  `✓ Known seed validates: 0x4d659218e32a3268`.
- `xxHash64("")` still equals `0xef46db3751d8e999`. Only inputs of 0–7 bytes
  remain canonical — `PRIME64_4` is used in both the merge rounds (inputs ≥ 32
  bytes) and the 8-byte tail step, so anything ≥ 8 bytes already diverges. A
  >32-byte known-answer vector pins the Zig-std behaviour against regression,
  and a real captured oracle (`cch-oracle.fixture.json`) pins it against an
  actual binary-produced `cch`.

## Toolbox / techniques (for next time)

- **`strace -e trace=…`** to find which syscall actually carries the payload.
- **ptrace tracer** (not LD_PRELOAD) when the target makes inline syscalls.
- **Software breakpoints (INT3)** rather than hardware/debug-register breakpoints
  when the code runs on a worker thread — INT3 lives in the shared text page.
- **`rr record`** needs `kernel.perf_event_paranoid <= 1`; it also can't help
  if the target uses inline syscalls the way Bun does, but it gives
  deterministic replay when it works.
- **Same-run capture** is essential: the body contains a per-request session
  UUID, so input and output must come from one invocation to compare.
- When a hash "looks standard but isn't," **capture the intermediate state**
  (accumulators) to localize the divergence to update vs. finalization, then
  diff constants against the disassembly.

## Gotchas worth remembering

- The hash preimage is the serialized body with the placeholder `cch=00000`,
  including the per-request `metadata.user_id` session UUID and all tools.
- Request bodies contain multibyte UTF-8 (tool descriptions use `→`, etc.).
  Capture and hash **raw bytes**; never round-trip through a JS string with
  `chunk.toString()`.
- The seed is shared across long runs of consecutive versions, so the
  known-seed fast path almost always avoids the binary scan.
