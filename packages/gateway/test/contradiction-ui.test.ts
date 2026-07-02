import { ensureProject, ltm } from "@loreai/core";
import { beforeEach, describe, expect, it } from "vitest";
import { handleUIRequest } from "../src/ui";

// Dashboard surface for #1123: the /ui/knowledge contradictions banner and its
// resolve / dismiss endpoints. Detection is covered in core; here we exercise
// the user-facing wiring (render + the two POST actions).

const PROJECT = "/test/contra-ui";

function seedPair(
  titleA: string,
  titleB: string,
): { a: string; b: string; pid: string } {
  const pid = ensureProject(PROJECT);
  const a = ltm.create({
    projectPath: PROJECT,
    category: "preference",
    title: titleA,
    content: `${titleA} content`,
    scope: "project",
    confidence: 0.9,
  });
  const b = ltm.create({
    projectPath: PROJECT,
    category: "preference",
    title: titleB,
    content: `${titleB} content`,
    scope: "project",
    confidence: 0.9,
  });
  ltm.recordContradiction({
    logicalIdA: a,
    logicalIdB: b,
    projectId: pid,
    similarity: 0.97,
    rationale: "opposite directives",
  });
  return { a, b, pid };
}

async function post(path: string): Promise<Response> {
  const url = new URL(`http://localhost${path}`);
  return handleUIRequest(new Request(url, { method: "POST" }), url);
}

describe("contradictions dashboard (#1123)", () => {
  beforeEach(() => {
    // Isolate: clear any open pairs left by earlier cases in this shared DB.
    for (const c of ltm.listOpenContradictions()) {
      ltm.setContradictionStatus(c.logicalIdA, c.logicalIdB, "dismissed");
    }
  });

  it("renders a banner listing open contradictions on /ui/knowledge", async () => {
    seedPair("Always use tabs", "Always use spaces");
    const url = new URL("http://localhost/ui/knowledge");
    const res = await handleUIRequest(new Request(url), url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("contradiction");
    expect(html).toContain("Always use tabs");
    expect(html).toContain("Always use spaces");
    // The resolve/dismiss action wiring is present.
    expect(html).toContain("/ui/api/contradiction/resolve/");
    expect(html).toContain("/ui/api/contradiction/dismiss/");
  });

  it("uses a static confirm() so a title with quotes can't break the delete guard", async () => {
    // esc() renders ' as &#39; and " as &quot;; the browser HTML-decodes those
    // back to ' / " inside an inline onsubmit handler. If the title were
    // interpolated into confirm('...'), a title like "Don't ..." would break the
    // JS string and the form would submit (delete!) with NO confirmation.
    seedPair("Don't use global state", 'Always use "global" state');
    const url = new URL("http://localhost/ui/knowledge");
    const res = await handleUIRequest(new Request(url), url);
    const html = await res.text();

    // Confirm text is static — no user title inside the inline JS.
    expect(html).toContain(
      "confirm('Delete the other entry and keep this one? This cannot be undone.')",
    );
    // The old interpolated pattern must never come back.
    expect(html).not.toContain("confirm('Keep");
    expect(html).not.toMatch(/confirm\('[^']*Don&#39;t/);
    // The banner still renders the (HTML-escaped) titles in text context.
    expect(html).toContain("Don&#39;t use global state");
  });

  it("dismiss keeps both entries but removes the pair from the open list", async () => {
    const { a, b } = seedPair("Deploy from main", "Deploy from release");
    expect(ltm.listOpenContradictions()).toHaveLength(1);

    const res = await post(`/ui/api/contradiction/dismiss/${a}/${b}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/ui/knowledge");

    expect(ltm.listOpenContradictions()).toHaveLength(0);
    // Both entries survive a dismiss.
    expect(ltm.get(a)).not.toBeNull();
    expect(ltm.get(b)).not.toBeNull();
    // Never re-surfaced / re-judged.
    expect(ltm.contradictionExists(a, b)).toBe(true);
  });

  it("resolve keeps one entry, removes the other, and clears the pair", async () => {
    const { a, b } = seedPair("Never mock the DB", "Always mock the DB");
    expect(ltm.listOpenContradictions()).toHaveLength(1);

    // Keep A, remove B.
    const res = await post(`/ui/api/contradiction/resolve/${a}/${b}`);
    expect(res.status).toBe(302);

    expect(ltm.get(b)).toBeNull(); // removed
    expect(ltm.isTombstoned(b)).toBe(true);
    expect(ltm.get(a)).not.toBeNull(); // kept
    expect(ltm.listOpenContradictions()).toHaveLength(0);
    // remove() purged the pair row entirely.
    expect(ltm.contradictionExists(a, b)).toBe(false);
  });

  it("resolve is a no-op when no contradiction is recorded between the two ids", async () => {
    // Two entries that exist but were never flagged as contradicting.
    const x = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Standalone rule X",
      content: "x",
      scope: "project",
      confidence: 0.9,
    });
    const y = ltm.create({
      projectPath: PROJECT,
      category: "preference",
      title: "Standalone rule Y",
      content: "y",
      scope: "project",
      confidence: 0.9,
    });
    expect(ltm.contradictionExists(x, y)).toBe(false);

    const res = await post(`/ui/api/contradiction/resolve/${x}/${y}`);
    expect(res.status).toBe(302);
    // Neither entry deleted — the endpoint is not a generic delete.
    expect(ltm.get(x)).not.toBeNull();
    expect(ltm.get(y)).not.toBeNull();
  });

  it("resolve is a no-op when keep and remove are the same id", async () => {
    const { a } = seedPair("Rule one", "Rule two");
    const res = await post(`/ui/api/contradiction/resolve/${a}/${a}`);
    expect(res.status).toBe(302);
    expect(ltm.get(a)).not.toBeNull(); // not deleted
  });
});
