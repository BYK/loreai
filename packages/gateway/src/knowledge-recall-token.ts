/** The canonical recall namespace used by durable knowledge hints. */
export function knowledgeRecallToken(entry: {
  id: string;
  category: string;
}): string {
  if (entry.category === "lat.md") return `lat:${entry.id}`;
  if (entry.id.startsWith("d:") || entry.id.startsWith("t:")) return entry.id;
  return `k:${entry.id}`;
}
