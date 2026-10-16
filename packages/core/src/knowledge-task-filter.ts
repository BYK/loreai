/** The checkpoint-time lexical rule evaluated by the admission prototype. */
const STOPWORDS = new Set(
  "a an and are as at be been but by can could do does for from had has have how i if in into is it its just like may more most my no not of on one only or our please should so some than that the their them then there these they this those to too use used using very want was we were what when where which who why will with would you your lets help need make get set add fix test tests file files code implement update change changes run check error issue project session model tool gateway core lore entry entries knowledge prompt context architecture gotcha decision pattern preference system assistant user current work task use always never must should ensure avoid preserve".split(
    /\s+/,
  ),
);

const MAX_SOURCE_LENGTH = 4_096;
const MAX_CANDIDATES = 128;
const MAX_TOTAL_LENGTH = 65_536;

function words(text: string): Set<string> {
  return new Set(
    (text.toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(
      (word) => !STOPWORDS.has(word),
    ),
  );
}

function overlap(
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): number {
  return [...left].filter((word) => right.has(word)).length;
}

type Candidate = Readonly<{ category: string; title: string; content: string }>;

export function filterTaskKnowledge<T extends Candidate>(
  entries: readonly T[],
  task: string,
  cue = "",
): T[] {
  // Missing tasks preserve the existing no-context fallback. Preferences and
  // recalled/source-file context are outside the evaluated knowledge gate.
  if (entries.length > MAX_CANDIDATES) return [...entries];
  const taskExcerpt =
    task.length <= MAX_SOURCE_LENGTH
      ? task
      : `${task.slice(0, 2_048)} ${task.slice(-2_047)}`;
  if (!taskExcerpt.trim()) return [...entries];
  const contextual = entries.filter(
    (entry) => !["preference", "recalled", "lat.md"].includes(entry.category),
  );
  const cueExcerpt = cue.slice(0, 200);
  // The evaluated tokenizer is English/ASCII. It cannot justify suppressing
  // facts for a task whose words it cannot represent.
  if (/\P{ASCII}/u.test(taskExcerpt.replace(/[^\p{L}]/gu, "")))
    return [...entries];
  const inputLength = contextual.reduce(
    (total, entry) => total + entry.title.length + entry.content.length,
    taskExcerpt.length + cueExcerpt.length,
  );
  // Never parse unbounded stored bodies or keep a partially evaluated pool.
  // Exhaustion preserves every candidate and its original ranking order.
  if (
    inputLength > MAX_TOTAL_LENGTH ||
    contextual.some(
      (entry) =>
        entry.title.length > MAX_SOURCE_LENGTH ||
        entry.content.length > MAX_SOURCE_LENGTH,
    )
  ) {
    return [...entries];
  }
  const taskWords = words(`${taskExcerpt} ${cueExcerpt}`);
  if (!taskWords.size) return [...entries];
  return entries.filter((entry) => {
    switch (entry.category) {
      case "preference":
      case "recalled":
      case "lat.md":
        return true;
      case "decision":
      case "pattern":
        return false;
      case "gotcha":
      case "architecture": {
        const title = words(entry.title);
        const body = words(entry.content);
        return (
          overlap(title, taskWords) > 0 ||
          overlap(body, taskWords) >= 2 ||
          (entry.category === "gotcha" && body.size >= 15 && body.size < 35)
        );
      }
      default:
        throw new Error("Invalid knowledge category in task filter");
    }
  });
}
