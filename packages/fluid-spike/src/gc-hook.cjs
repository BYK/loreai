process.on("message", (message) => {
  if (message?.type !== "force-gc") return;
  if (typeof global.gc !== "function") {
    process.send?.({
      type: "gc-complete",
      id: message.id,
      error: "global.gc unavailable",
    });
    return;
  }
  global.gc();
  global.gc();
  const memory = process.memoryUsage();
  process.send?.({
    type: "gc-complete",
    id: message.id,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
  });
});
