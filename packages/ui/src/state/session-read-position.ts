export function absoluteMessageIndex(
  localIndex: number,
  messageCount: number | null,
  loadedLength: number,
): number {
  const base = (messageCount ?? loadedLength) - loadedLength;
  return base + localIndex;
}
