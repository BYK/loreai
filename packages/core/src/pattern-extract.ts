/**
 * Lightweight regex-based pattern extraction from distillation observations.
 *
 * Scans for decision/preference/choice patterns and returns structured
 * extractions that can be stored as knowledge entries. No LLM required.
 *
 * Patterns target how decisions and preferences are typically expressed
 * in distilled engineering context:
 *   - "decided to use X"
 *   - "chose X over Y"
 *   - "switched from X to Y"
 *   - "prefers X for Y"
 *   - "going with X because Y"
 *
 * Also matches process instruction patterns from distilled observations
 * where the observer normalizes user assertions:
 *   - "User stated always X"
 *   - "User said never Y"
 *   - "User stated make sure to X"
 *   - "User stated don't forget to X"
 *
 * Extracted entries participate in the normal curator cycle — the curator
 * can consolidate or remove them based on actual value. The extraction is
 * a cheap seed, not a permanent fixture.
 */

export type ExtractedPattern = {
  category: "decision" | "preference";
  /** Short descriptive title, e.g. "Chose PostgreSQL over MySQL". */
  title: string;
  /** Full matched text for context. */
  content: string;
};

type PatternDef = {
  regex: RegExp;
  category: "decision" | "preference";
  titleFn: (match: RegExpMatchArray) => string;
};

const PATTERNS: PatternDef[] = [
  // Decision patterns
  {
    regex: /decided to (?:use |switch to |go with |adopt )(.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Decided to use ${m[1].trim()}`,
  },
  {
    regex: /chose (.+?) over (.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Chose ${m[1].trim()} over ${m[2].trim()}`,
  },
  {
    regex: /switched from (.+?) to (.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Switched from ${m[1].trim()} to ${m[2].trim()}`,
  },
  {
    regex: /going with (.+?) (?:because|for|due to)(.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Going with ${m[1].trim()}`,
  },
  {
    regex: /migrat(?:ed|ing) (?:from .+? )?to (.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Migrated to ${m[1].trim()}`,
  },
  {
    regex: /adopted (.+?) (?:for|as|instead)(.+?)(?:\.|,|$)/gi,
    category: "decision",
    titleFn: (m) => `Adopted ${m[1].trim()}`,
  },

  // Preference patterns
  {
    regex:
      /prefers? (.+?) (?:over|to|instead of|rather than) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Prefers ${m[1].trim()} over ${m[2].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:always |usually |typically )(?:use|prefer|go with) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Typically uses ${m[1].trim()}`,
  },

  // Declarative preference patterns — match distilled observations recording
  // user practices/conventions stated as facts rather than directives.
  // Uses "uses/likes" but NOT "prefers" to avoid overlap with the comparison
  // pattern above ("prefers X over/to Y").
  {
    regex:
      /(?:user |team |we )(?:uses?|likes?) (.+?) (?:for|as|when|in) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Uses ${m[1].trim()} for ${m[2].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:doesn't|does not|don't|do not) (?:like|use|want) (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Avoids ${m[1].trim()}`,
  },
  {
    regex: /(?:the |our |project )convention is (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Convention: ${m[1].trim()}`,
  },

  // Process instruction patterns — match distilled observations recording
  // user assertions about workflow/process rules. The distillation observer
  // normalizes user instructions into "User stated always X" phrasing.
  // These require "stated/asserted/said" to avoid overlapping with the
  // existing "typically uses" pattern above (which already handles
  // "user always use/prefer/go with X").
  {
    regex:
      /(?:user |team |we )(?:stated |asserted |said )(?:to )?always (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Always ${m[1].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:stated |asserted |said )(?:to )?never (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Never ${m[1].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:stated |asserted |said )(?:to )?make sure to (.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Make sure to ${m[1].trim()}`,
  },
  {
    regex:
      /(?:user |team |we )(?:stated |asserted |said )(?:to )?(?:don't|do not) forget (?:to )?(.+?)(?:\.|,|$)/gi,
    category: "preference",
    titleFn: (m) => `Always ${m[1].trim()}`,
  },
];

/**
 * A pattern-extracted title is `prefix + raw capture group` bounded only by
 * `(.+?)(?:\.|,|$)`, so a capture that runs to the first comma/period/EOL can
 * drag in long multi-clause prose — producing junk titles like
 * "Always the same: the agent never called the save step in the first" or
 * "Chose checkout under different path, NULL git_remote); 4) converge…".
 *
 * A discoverable title (the article's thesis, applied to Lore's own memory) is a
 * short, specific term a future session will actually search — not a sentence.
 * So a produced title is rejected as NOISE when it is too long to be a
 * name/short phrase, or carries sentence-structure punctuation that only appears
 * when prose leaked past the intended boundary. Rejecting is safe: pattern-
 * extract is a best-effort seed, and skipping a bad mint is always better than
 * creating a low-discoverability entry the curator later has to clean up (and
 * whose delete busts the prompt cache).
 *
 * The gate is applied to the FINAL title, not individual captures, because some
 * patterns capture a trailing clause they never put in the title (e.g. the
 * "because Y" tail of "going with X because Y") — gating that tail would wrongly
 * drop a perfectly good "Going with X".
 */
const MAX_TITLE_WORDS = 10;
const MAX_TITLE_CHARS = 72;
// Structure punctuation that a clean title never contains, but multi-clause
// prose leaked past the `,`/`.` boundary does: clause separators (; :) and
// parentheses. (An enumerated-list marker like "4)" is already caught by the
// bare `)`, so no separate digit-paren alternative is needed.)
const TITLE_NOISE_RE = /[;:()]/;
// The ONLY title-prefix a titleFn adds that legitimately carries punctuation is
// the `Convention: ` label — strip it before the noise scan so its colon isn't
// mistaken for leaked prose. (Everything after it is still scanned.)
const SAFE_TITLE_PREFIX_RE = /^Convention: /;

function isNoisyTitle(title: string): boolean {
  if (title.length > MAX_TITLE_CHARS) return true;
  if (title.split(/\s+/).length > MAX_TITLE_WORDS) return true;
  if (TITLE_NOISE_RE.test(title.replace(SAFE_TITLE_PREFIX_RE, ""))) return true;
  return false;
}

/**
 * Extract decision/preference patterns from distillation observations text.
 *
 * Returns structured entries suitable for `ltm.create()`. Deduplicates by
 * lowercased title within a single call.
 *
 * @param observations  The distilled observations text to scan.
 * @returns             Array of extracted patterns (may be empty).
 */
export function extractPatterns(observations: string): ExtractedPattern[] {
  const results: ExtractedPattern[] = [];
  const seen = new Set<string>();

  for (const { regex, category, titleFn } of PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    regex.lastIndex = 0;
    let match = regex.exec(observations);
    while (match !== null) {
      const current = match;
      match = regex.exec(observations);
      // Skip false positives: template placeholders (e.g. "X", "Y"),
      // quoted fragments, or very short captures that are clearly not
      // real technology/tool names. Plain apostrophes (') are allowed
      // since they appear in valid names like "Bun's test runner".
      const captures = current.slice(1);
      if (
        captures.some(
          (c) =>
            c &&
            (c.trim().length <= 2 || /["\u201C\u201D`\u2018\u2019]/.test(c)),
        )
      )
        continue;

      const title = titleFn(current);
      // Skip noisy titles: prose that leaked past the `,`/`.` boundary makes a
      // long, unsearchable title. A discoverable title names its subject in a few
      // words — not a full clause. Better to not mint than to mint junk.
      if (isNoisyTitle(title)) continue;
      const key = title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push({ category, title, content: current[0].trim() });
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Action tag extraction and cross-session counting
// ---------------------------------------------------------------------------

/**
 * Regex to match action tags like [requested-tests], [corrected-style], etc.
 *
 * Every kebab segment must be >=2 chars. This deliberately excludes literal
 * single-letter character ranges that appear in code/prose — e.g. `[a-z]`,
 * `[a-f]` — which the old `/\[([a-z]+-[a-z-]+)\]/g` matched as a tag "a-z" and
 * turned into a garbage preference titled "A Z" (ses_14b9bf3d… cache-bust
 * incident: such junk pollutes system[1] and busts the prompt cache when later
 * deleted by consolidation).
 */
const ACTION_TAG_RE = /\[([a-z]{2,}(?:-[a-z]{2,})+)\]/g;

/**
 * Extract action tags from distillation observation text.
 * Returns deduplicated tag names (e.g., "requested-tests", "corrected-style").
 */
export function extractActionTags(observations: string): string[] {
  const tags = new Set<string>();
  ACTION_TAG_RE.lastIndex = 0;
  let match = ACTION_TAG_RE.exec(observations);
  while (match !== null) {
    tags.add(match[1]);
    match = ACTION_TAG_RE.exec(observations);
  }
  return [...tags];
}

/** Map from tag name to human-readable preference title. */
const TAG_TITLE_MAP: Record<string, string> = {
  "requested-tests": "Always write tests alongside implementation",
  "corrected-style": "Follow consistent code style conventions",
  "rejected-approach": "Respect explicitly rejected approaches",
  "requested-error-handling":
    "Always add proper error handling with try/catch and status codes",
  "requested-review": "Review code before committing",
  "enforced-workflow":
    "Follow the established git workflow (branch, PR, review)",
};

/**
 * Whether a tag is a curated, known action tag (present in TAG_TITLE_MAP).
 *
 * Minting preference entries must be gated on this: `tagToTitle` manufactures a
 * title-cased fallback for ANY string, so without an allow-list a spurious
 * regex match (e.g. a stray `[foo-bar]`) would become a knowledge entry. Only
 * tags we have a deliberate canonical title for are real behavioral signals.
 */
export function isKnownActionTag(tag: string): boolean {
  return Object.hasOwn(TAG_TITLE_MAP, tag);
}

/**
 * Generate a preference title from a tag name.
 * Uses the predefined map for common tags, falls back to title-casing.
 */
export function tagToTitle(tag: string): string {
  if (TAG_TITLE_MAP[tag]) return TAG_TITLE_MAP[tag];
  // Fallback: convert kebab-case to title case
  return tag
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
