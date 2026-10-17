/** Keep the beginning and the latest instruction when a task exceeds its budget. */
export function taskHintExcerpt(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) return trimmed;
  const headChars = Math.floor(maxChars / 4);
  const tailChars = maxChars - headChars - 1;
  return `${trimmed.slice(0, headChars)}\n${trimmed.slice(-tailChars)}`;
}
