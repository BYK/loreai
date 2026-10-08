// Generate a deterministic, tool-readable project artifact. The change contract
// lives in this file rather than being duplicated in the user prompt; the vendor
// records make it realistic to navigate without claiming every byte was read.
export function renderReferenceContext(turn) {
  const { sizeKb, spec } = turn.toolContext;
  const validSize =
    Number.isSafeInteger(sizeKb) && sizeKb >= 1 && sizeKb <= 256;
  if (!validSize || !spec?.trim()) {
    throw new Error(
      "reference context needs a non-empty spec and 1-256 KiB size",
    );
  }
  const header = `# Vendor reference for ${turn.checkpoint}\nSKU,unit_price_cents,stock,zone\n`;
  const contract = `\n## Change contract\n${spec.trim()}\n`;
  const fillerBytes = sizeKb * 1024 - header.length - contract.length;
  if (fillerBytes < 0) {
    throw new Error("reference contract exceeds artifact size");
  }
  const rowCount = Math.ceil(fillerBytes / 24) + 1;
  const records = Array.from({ length: rowCount }, (_, index) => {
    const sku = `SKU-${String(index).padStart(6, "0")}`;
    const price = 100 + ((index * 37) % 9000);
    const stock = 1 + ((index * 13) % 500);
    return `${sku},${price},${stock},${index % 2 ? "REMOTE" : "LOCAL"}\n`;
  }).join("");
  return `${header}${records.slice(0, Math.max(0, fillerBytes))}${contract}`;
}
