// Small complete objects, validated against the actual configuration schema in tests.
// These are deliberate overrides, rather than a second copy of the defaults.
export const COMMON_SETTING_EXAMPLES = [
  {
    path: "curator.maxEntries",
    title: "Keep up to 30 active curated entries",
    description:
      "Set the curator's entry limit; consolidation manages this active set.",
    value: { curator: { maxEntries: 30 } },
  },
  {
    path: "cache.warming.enabled",
    title: "Disable speculative cache warming",
    description:
      "Stop keepalive requests for cached context. Normal provider calls still run.",
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
