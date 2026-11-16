// Small complete objects, validated against the actual configuration schema in tests.
// These are deliberate overrides, rather than a second copy of the defaults.
export const COMMON_SETTING_EXAMPLES = [
  {
    path: "curator.maxEntries",
    title: "Keep up to 30 active curated entries",
    description:
      "Lower the default limit from 200 to 30. The curator can remove lower-value active entries to meet the new limit. Review your existing knowledge first, then check the .lore.md diff after the curator runs.",
    value: { curator: { maxEntries: 30 } },
  },
  {
    path: "cache.warming.enabled",
    title: "Disable speculative cache warming",
    description:
      "Set the file preference to stop keepalive requests. Before relying on this to control costs, check LORE_WARMING_ENABLED first, then the saved dashboard preference. Both override the file. Normal provider calls still run.",
    value: { cache: { warming: { enabled: false } } },
  },
  {
    path: "search.embeddings.enabled",
    title: "Use recall without vector embeddings",
    description:
      "Disable vector embedding search while keeping keyword recall available.",
    value: { search: { embeddings: { enabled: false } } },
  },
];
