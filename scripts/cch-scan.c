/*
 * cch-scan.c — native xxHash64 seed scanner for Claude Code `cch` extraction.
 *
 * The TypeScript extractor (scripts/extract-cch-seed.ts) captures oracle pairs
 * (a request body containing `cch=00000` + the 5-hex `cch` the binary produced)
 * and then must find the 64-bit xxHash64 seed embedded in the ~230 MB binary
 * that reproduces every pair. The pure-JS scan of ~31M candidates does not fit
 * the 30-minute CI budget, so this small, dependency-free C program does the
 * hot loop instead (typically a few seconds with -O3).
 *
 * It is compiled on the fly by extract-cch-seed.ts via `cc -O3`; if no compiler
 * is available the TypeScript falls back to the JS scan. The xxHash64 here MUST
 * stay bit-for-bit identical to packages/gateway/src/xxhash.ts (including the
 * non-canonical PRIME64_4 — see below).
 *
 * Usage:
 *   cch-scan <binary> <alignment> <pairs-file>
 *
 *   <binary>      path to the Claude Code binary to scan
 *   <alignment>   candidate stride in bytes (8 then 1, matching the JS scan)
 *   <pairs-file>  oracle pairs, one per line: "<cch-hex>\t<byte-length>\n"
 *                 followed immediately by <byte-length> raw body bytes, then a
 *                 single '\n' separator. Repeated for each pair. Passing bodies
 *                 as raw bytes (not argv/JSON) avoids any encoding or quoting
 *                 pitfalls.
 *
 * Output (stdout):
 *   On success: "SEED 0x%016llx\n" (the matching little-endian uint64 seed)
 *   On no match: "NONE\n"
 * Exit code is 0 in both cases; non-zero only on usage/IO errors.
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <sys/stat.h>

/*
 * Claude Code's cch primes — must match packages/gateway/src/xxhash.ts.
 * PRIME64_4 is NON-CANONICAL: Bun's Bun.hash.xxHash64 uses Zig's std
 * std.hash.XxHash64, whose prime_4 is 0x85ebca77c2b2ae63 (reference xxHash64
 * uses 0x85ebca6b3b7b36ef). See xxhash.ts for the full explanation.
 */
static const uint64_t PRIME64_1 = 0x9e3779b185ebca87ULL;
static const uint64_t PRIME64_2 = 0xc2b2ae3d27d4eb4fULL;
static const uint64_t PRIME64_3 = 0x165667b19e3779f9ULL;
static const uint64_t PRIME64_4 = 0x85ebca77c2b2ae63ULL;
static const uint64_t PRIME64_5 = 0x27d4eb2f165667c5ULL;

static inline uint64_t rotl64(uint64_t x, int r) {
  return (x << r) | (x >> (64 - r));
}

static inline uint64_t read_u64_le(const uint8_t *p) {
  uint64_t v;
  memcpy(&v, p, 8); /* host is little-endian on x86-64/arm64 CI runners */
  return v;
}

static inline uint32_t read_u32_le(const uint8_t *p) {
  uint32_t v;
  memcpy(&v, p, 4);
  return v;
}

static inline uint64_t xx_round(uint64_t acc, uint64_t input) {
  acc += input * PRIME64_2;
  acc = rotl64(acc, 31);
  acc *= PRIME64_1;
  return acc;
}

static inline uint64_t xx_merge_round(uint64_t acc, uint64_t val) {
  val = xx_round(0, val);
  acc ^= val;
  acc = acc * PRIME64_1 + PRIME64_4;
  return acc;
}

/* xxHash64 of `data[0..len)` with `seed`. Mirrors xxhash.ts:79-146. */
static uint64_t xxhash64(const uint8_t *data, size_t len, uint64_t seed) {
  const uint8_t *p = data;
  const uint8_t *const end = data + len;
  uint64_t h64;

  if (len >= 32) {
    const uint8_t *const limit = end - 32;
    uint64_t v1 = seed + PRIME64_1 + PRIME64_2;
    uint64_t v2 = seed + PRIME64_2;
    uint64_t v3 = seed + 0;
    uint64_t v4 = seed - PRIME64_1;

    do {
      v1 = xx_round(v1, read_u64_le(p));
      p += 8;
      v2 = xx_round(v2, read_u64_le(p));
      p += 8;
      v3 = xx_round(v3, read_u64_le(p));
      p += 8;
      v4 = xx_round(v4, read_u64_le(p));
      p += 8;
    } while (p <= limit);

    h64 = rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18);
    h64 = xx_merge_round(h64, v1);
    h64 = xx_merge_round(h64, v2);
    h64 = xx_merge_round(h64, v3);
    h64 = xx_merge_round(h64, v4);
  } else {
    h64 = seed + PRIME64_5;
  }

  h64 += (uint64_t)len;

  while (p + 8 <= end) {
    uint64_t k1 = xx_round(0, read_u64_le(p));
    h64 ^= k1;
    h64 = rotl64(h64, 27) * PRIME64_1 + PRIME64_4;
    p += 8;
  }

  if (p + 4 <= end) {
    h64 ^= (uint64_t)read_u32_le(p) * PRIME64_1;
    h64 = rotl64(h64, 23) * PRIME64_2 + PRIME64_3;
    p += 4;
  }

  while (p < end) {
    h64 ^= (uint64_t)(*p) * PRIME64_5;
    h64 = rotl64(h64, 11) * PRIME64_1;
    p++;
  }

  /* final avalanche */
  h64 ^= h64 >> 33;
  h64 *= PRIME64_2;
  h64 ^= h64 >> 29;
  h64 *= PRIME64_3;
  h64 ^= h64 >> 32;
  return h64;
}

typedef struct {
  uint8_t *body;
  size_t len;
  uint32_t cch; /* expected low-20-bits value */
} Pair;

/* Test whether `seed` reproduces every pair's cch (low 20 bits of the hash). */
static inline int test_candidate(uint64_t seed, const Pair *pairs, int n) {
  for (int i = 0; i < n; i++) {
    uint64_t h = xxhash64(pairs[i].body, pairs[i].len, seed);
    if ((uint32_t)(h & 0xfffffULL) != pairs[i].cch) return 0;
  }
  return 1;
}

static Pair *load_pairs(const char *path, int *out_n) {
  FILE *f = fopen(path, "rb");
  if (!f) {
    fprintf(stderr, "cch-scan: cannot open pairs file %s\n", path);
    return NULL;
  }

  int cap = 8, n = 0;
  Pair *pairs = malloc(sizeof(Pair) * cap);
  if (!pairs) {
    fclose(f);
    return NULL;
  }

  for (;;) {
    char cchhex[16];
    long blen;
    int r = fscanf(f, "%15[0-9a-f]\t%ld\n", cchhex, &blen);
    if (r != 2) break;
    if (blen < 0) break;

    if (n == cap) {
      cap *= 2;
      Pair *np = realloc(pairs, sizeof(Pair) * cap);
      if (!np) {
        free(pairs);
        fclose(f);
        return NULL;
      }
      pairs = np;
    }

    uint8_t *body = malloc((size_t)blen);
    if (!body && blen > 0) {
      free(pairs);
      fclose(f);
      return NULL;
    }
    if (blen > 0 && fread(body, 1, (size_t)blen, f) != (size_t)blen) {
      fprintf(stderr, "cch-scan: short read on pair body\n");
      free(body);
      free(pairs);
      fclose(f);
      return NULL;
    }
    int sep = fgetc(f); /* consume trailing '\n' separator */
    (void)sep;

    pairs[n].body = body;
    pairs[n].len = (size_t)blen;
    pairs[n].cch = (uint32_t)strtoul(cchhex, NULL, 16);
    n++;
  }

  fclose(f);
  *out_n = n;
  return pairs;
}

int main(int argc, char **argv) {
  if (argc != 4) {
    fprintf(stderr, "usage: %s <binary> <alignment> <pairs-file>\n", argv[0]);
    return 2;
  }

  const char *binpath = argv[1];
  long alignment = strtol(argv[2], NULL, 10);
  if (alignment != 1 && alignment != 8) {
    fprintf(stderr, "cch-scan: alignment must be 1 or 8\n");
    return 2;
  }

  int npairs = 0;
  Pair *pairs = load_pairs(argv[3], &npairs);
  if (!pairs || npairs == 0) {
    fprintf(stderr, "cch-scan: no oracle pairs loaded\n");
    return 2;
  }

  int fd = open(binpath, O_RDONLY);
  if (fd < 0) {
    fprintf(stderr, "cch-scan: cannot open binary %s\n", binpath);
    return 2;
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    fprintf(stderr, "cch-scan: fstat failed\n");
    close(fd);
    return 2;
  }
  size_t size = (size_t)st.st_size;
  if (size < 8) {
    printf("NONE\n");
    close(fd);
    return 0;
  }

  uint8_t *map = mmap(NULL, size, PROT_READ, MAP_PRIVATE, fd, 0);
  if (map == MAP_FAILED) {
    fprintf(stderr, "cch-scan: mmap failed\n");
    close(fd);
    return 2;
  }
  madvise(map, size, MADV_SEQUENTIAL);

  uint64_t found = 0;
  int have = 0;
  size_t last = size - 8;
  for (size_t off = 0; off <= last; off += (size_t)alignment) {
    uint64_t cand = read_u64_le(map + off);
    if (cand == 0) continue;
    if (test_candidate(cand, pairs, npairs)) {
      found = cand;
      have = 1;
      break; /* first match; 2+ pairs make it unique */
    }
  }

  munmap(map, size);
  close(fd);
  for (int i = 0; i < npairs; i++) free(pairs[i].body);
  free(pairs);

  if (have) {
    printf("SEED 0x%016llx\n", (unsigned long long)found);
  } else {
    printf("NONE\n");
  }
  return 0;
}
