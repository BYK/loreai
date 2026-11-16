#!/usr/bin/env node
// Documentary crops of the 2x fictional-data captures. No pixels are redrawn.
// Regions are expressed in CSS pixels, then extracted at the capture density.
import sharp from "sharp";
import { fileURLToPath } from "node:url";
const directory = fileURLToPath(
  new URL("../public/product-tour/", import.meta.url),
);
for (const theme of ["light", "dark"]) {
  const crops = [
    {
      source: "session-detail",
      name: "session-detail-mobile",
      region: { left: 386, top: 48, width: 394, height: 500 },
    },
    {
      source: "knowledge-mobile",
      name: "proof-rule-mobile",
      region: { left: 0, top: 300, width: 390, height: 185 },
    },
    {
      source: "knowledge-detail",
      name: "proof-source-mobile",
      region: { left: 28, top: 330, width: 340, height: 205 },
    },
    {
      source: "knowledge-detail",
      name: "proof-history-mobile",
      region: { left: 28, top: 535, width: 678, height: 177 },
    },
    {
      source: "sessions",
      name: "sessions-mobile",
      region: { left: 76, top: 80, width: 470, height: 580 },
    },
    {
      source: "usage",
      name: "usage-mobile",
      region: { left: 90, top: 336, width: 1000, height: 424 },
    },
  ];
  for (const { source, name, region } of crops)
    await sharp(`${directory}${source}-${theme}.png`)
      .extract(
        Object.fromEntries(
          Object.entries(region).map(([key, value]) => [key, value * 2]),
        ),
      )
      .png()
      .toFile(`${directory}${name}-${theme}.png`);
}
