import { describe, expect, test } from "vitest";
import { config } from "../src/config";
import { create } from "../src/ltm";
import { runRecallWithMetadata, recallByIdWithMetadata } from "../src/recall";
import { withTenant } from "../src/tenant";

describe("local recall detail capacity", () => {
  test("retains more than 64 unread local refs across sessions without evicting hosted refs", async () => {
    const projectPath = "/test/recall-local-capacity";
    const marker = "localcapacityneedle";
    const content = `${marker} ${"bounded detail content ".repeat(300)}`;
    const search = config().search;
    const searchConfig = {
      ...search,
      queryExpansion: false,
      embeddings: { ...search.embeddings, enabled: false },
    };
    for (const owner of ["", "hosted-capacity-owner"]) {
      withTenant(owner, () =>
        create({
          projectPath,
          category: "gotcha",
          title: marker,
          content,
          scope: "project",
        }),
      );
    }
    const refs: string[] = [];
    const mint = async (owner: string, sessionID: string) => {
      const preview = await withTenant(owner, () =>
        runRecallWithMetadata({
          query: marker,
          projectPath,
          sessionID,
          scope: "project",
          detailRefs: true,
          searchConfig,
        }),
      );
      const ref = preview.result.match(/detail ref: `([^`]+)`/)?.[1];
      expect(ref).toMatch(/^r:[0-9a-f-]{36}$/);
      if (!ref) throw new Error("Expected an opaque detail ref");
      return ref;
    };
    const hostedRef = await mint("hosted-capacity-owner", "hosted-session");
    for (let index = 0; index < 65; index++) {
      refs.push(await mint("", `local-session-${index}`));
    }
    // Do not read the earliest ref until all other sessions have produced
    // theirs: otherwise the LRU refresh can mask premature eviction.
    expect(
      recallByIdWithMetadata(refs[0], {
        projectPath,
        sessionID: "local-session-0",
      }).result,
    ).toContain(marker);
    expect(
      withTenant(
        "hosted-capacity-owner",
        () =>
          recallByIdWithMetadata(hostedRef, {
            projectPath,
            sessionID: "hosted-session",
          }).result,
      ),
    ).toContain(marker);
    expect(
      withTenant(
        "hosted-capacity-owner",
        () =>
          recallByIdWithMetadata(refs[0], {
            projectPath,
            sessionID: "local-session-0",
          }).result,
      ),
    ).toBe("No matching recall detail.");
  });
});
