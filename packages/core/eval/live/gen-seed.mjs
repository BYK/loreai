// Generates the seed repo for the live counterfactual benchmark.
//
// Design goals:
//   1. Pure Python stdlib (sqlite3 + unittest) — end-goal tests run with
//      `python3 -m unittest` and ZERO pip installs (no network, robust).
//   2. LARGE + cross-cutting so a session's context grows past the compaction
//      threshold (~136K on a 200K model) ~2x. Achieved with N resource modules,
//      each with PER-MODULE VARIATION (distinct validation rules stated in that
//      module's own docstring), so the agent must actually READ each module to
//      implement its stubs correctly — not copy-paste one pattern.
//   3. Each module ships working CRUD (to read) + 2 stubbed functions
//      (`validate`, `summary`) the agent must implement (the end goal), graded
//      by that module's unittest.
//   4. MEMORY probes (#961 axes) are NOT here — they live only in the session
//      prompts (code-invisible), so a fresh no-Lore session can't recover them.
//
// Usage: bun gen-seed.mjs <target-dir> [resourceCount]

import fs from "node:fs";
import path from "node:path";

const DEST = path.resolve(process.argv[2] || "./seed");
const N = Number(process.argv[3] || "24");
fs.rmSync(DEST, { recursive: true, force: true });
const W = (rel, content) => {
  const p = path.join(DEST, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
};

// Per-resource domain names + a distinct validation rule each (forces reading).
const NOUNS = [
  "widget",
  "gadget",
  "sprocket",
  "cog",
  "valve",
  "piston",
  "gasket",
  "bearing",
  "flange",
  "coupler",
  "bracket",
  "rivet",
  "bushing",
  "spindle",
  "rotor",
  "stator",
  "armature",
  "manifold",
  "nozzle",
  "impeller",
  "turbine",
  "camshaft",
  "crank",
  "pulley",
  "axle",
  "hub",
  "clutch",
  "gearset",
  "damper",
  "actuator",
  "sensor",
  "relay",
];
// Each resource gets one of these distinct validation rules (stated in its docstring).
const RULES = [
  {
    desc: "value_cents must be a multiple of 5",
    check: "row['value_cents'] % 5 == 0",
  },
  { desc: "quantity must be strictly positive", check: "row['quantity'] > 0" },
  {
    desc: "name must be at least 3 characters",
    check: "len(row['name']) >= 3",
  },
  {
    desc: "value_cents must be <= 1_000_000",
    check: "row['value_cents'] <= 1000000",
  },
  { desc: "quantity must be <= 10_000", check: "row['quantity'] <= 10000" },
  {
    desc: "name must be lowercase",
    check: "row['name'] == row['name'].lower()",
  },
  {
    desc: "value_cents must be non-zero when quantity>0",
    check: "(row['value_cents'] != 0) or (row['quantity'] == 0)",
  },
  { desc: "quantity must be even", check: "row['quantity'] % 2 == 0" },
];

// Emit realistic, VALID query/aggregate helpers so each module is large enough
// (~6K tokens) that reading it meaningfully fills the agent's context. These are
// real functions (not dead filler) — a large service module the agent must scan.
function bulkFunctions(noun, table) {
  const specs = [
    [
      "count_all",
      "Total number of rows.",
      `return conn.execute("SELECT COUNT(*) AS n FROM ${table}").fetchone()["n"]`,
    ],
    [
      "count_where_quantity_gt",
      "Count rows with quantity greater than the threshold.",
      `return conn.execute("SELECT COUNT(*) AS n FROM ${table} WHERE quantity > ?", (threshold,)).fetchone()["n"]`,
      "threshold",
    ],
    [
      "sum_value_cents",
      "Sum of value_cents across all rows.",
      `return conn.execute("SELECT COALESCE(SUM(value_cents),0) AS s FROM ${table}").fetchone()["s"]`,
    ],
    [
      "avg_value_cents",
      "Average value_cents (0 when empty).",
      `r = conn.execute("SELECT AVG(value_cents) AS a FROM ${table}").fetchone()["a"]\n    return int(r) if r is not None else 0`,
    ],
    [
      "max_quantity",
      "Largest quantity, or 0 when empty.",
      `r = conn.execute("SELECT MAX(quantity) AS m FROM ${table}").fetchone()["m"]\n    return r or 0`,
    ],
    [
      "min_quantity",
      "Smallest quantity, or 0 when empty.",
      `r = conn.execute("SELECT MIN(quantity) AS m FROM ${table}").fetchone()["m"]\n    return r or 0`,
    ],
    [
      "find_by_name",
      "Return the first row with the given name, or None.",
      `r = conn.execute("SELECT * FROM ${table} WHERE name = ? LIMIT 1", (name,)).fetchone()\n    return dict(r) if r else None`,
      "name",
    ],
    [
      "search_name_prefix",
      "Rows whose name starts with the given prefix.",
      `rows = conn.execute("SELECT * FROM ${table} WHERE name LIKE ? ORDER BY id", (prefix + '%',)).fetchall()\n    return [dict(r) for r in rows]`,
      "prefix",
    ],
    [
      "page",
      "Return a page of rows (limit/offset).",
      `rows = conn.execute("SELECT * FROM ${table} ORDER BY id LIMIT ? OFFSET ?", (limit, offset)).fetchall()\n    return [dict(r) for r in rows]`,
      "limit, offset=0",
    ],
    [
      "update_quantity",
      "Set the quantity for a row and return the updated row.",
      `conn.execute("UPDATE ${table} SET quantity = ? WHERE id = ?", (quantity, row_id))\n    conn.commit()\n    return get_${noun}(conn, row_id)`,
      "row_id, quantity",
    ],
    [
      "update_value_cents",
      "Set value_cents for a row and return the updated row.",
      `conn.execute("UPDATE ${table} SET value_cents = ? WHERE id = ?", (value_cents, row_id))\n    conn.commit()\n    return get_${noun}(conn, row_id)`,
      "row_id, value_cents",
    ],
    [
      "delete_row",
      "Delete a row by id; returns True if a row was removed.",
      `cur = conn.execute("DELETE FROM ${table} WHERE id = ?", (row_id,))\n    conn.commit()\n    return cur.rowcount > 0`,
      "row_id",
    ],
    [
      "total_inventory_value",
      "Sum of value_cents*quantity across all rows.",
      `rows = conn.execute("SELECT value_cents, quantity FROM ${table}").fetchall()\n    return sum(r["value_cents"] * r["quantity"] for r in rows)`,
    ],
    [
      "names",
      "All names in id order.",
      `return [r["name"] for r in conn.execute("SELECT name FROM ${table} ORDER BY id").fetchall()]`,
    ],
    [
      "exists",
      "Whether a row with the given id exists.",
      `return conn.execute("SELECT 1 FROM ${table} WHERE id = ?", (row_id,)).fetchone() is not None`,
      "row_id",
    ],
    [
      "bulk_create",
      "Insert many rows from a list of (name, value_cents, quantity) tuples.",
      `for (nm, vc, q) in items:\n        conn.execute("INSERT INTO ${table} (name, value_cents, quantity, created_at) VALUES (?, ?, ?, ?)", (nm, vc, q, now_iso()))\n    conn.commit()\n    return len(items)`,
      "items",
    ],
    [
      "clear",
      "Delete all rows; returns the number removed.",
      `cur = conn.execute("DELETE FROM ${table}")\n    conn.commit()\n    return cur.rowcount`,
    ],
    [
      "top_by_value",
      "Return the n rows with the highest value_cents.",
      `rows = conn.execute("SELECT * FROM ${table} ORDER BY value_cents DESC, id LIMIT ?", (n,)).fetchall()\n    return [dict(r) for r in rows]`,
      "n",
    ],
  ];
  // Repeat the spec set with numbered suffixes to size each module to ~6K
  // tokens (kept < the read-tool truncation limit so full reads land in context).
  const REPS = Number(process.env.MODULE_REPS || "4");
  const out = [];
  for (let r = 0; r < REPS; r++) {
    for (const [fn, doc, body, params] of specs) {
      const name = r === 0 ? fn : `${fn}_v${r + 1}`;
      const sig = params ? `conn, ${params}` : "conn";
      out.push(
        `def ${name}(${sig}):\n    """${doc} (variant ${r + 1})"""\n    ${body}\n`,
      );
    }
  }
  return out.join("\n");
}

function resourceModule(idx) {
  const noun =
    NOUNS[idx % NOUNS.length] +
    (idx >= NOUNS.length ? String(Math.floor(idx / NOUNS.length)) : "");
  const rule = RULES[idx % RULES.length];
  const table = `${noun}s`;
  const code = `"""${noun} service.

CRUD is implemented below (mirror this style for the stubs).

MODULE-SPECIFIC VALIDATION RULE (read carefully — it differs per module):
    A ${noun} row is valid iff: ${rule.desc}.

TODO(agent): implement validate(row) and summary(conn) at the bottom so the
tests in tests/test_${noun}.py pass. validate(row) returns True when the row
satisfies this module's rule above, else raises ValueError. summary(conn)
returns {"count": <int>, "total_value_cents": <int>} over all rows.
"""
from .util.time import now_iso


def create_${noun}(conn, name, value_cents, quantity):
    conn.execute(
        "INSERT INTO ${table} (name, value_cents, quantity, created_at) VALUES (?, ?, ?, ?)",
        (name, value_cents, quantity, now_iso()),
    )
    conn.commit()
    return conn.execute("SELECT last_insert_rowid() AS id").fetchone()["id"]


def get_${noun}(conn, row_id):
    r = conn.execute("SELECT * FROM ${table} WHERE id = ?", (row_id,)).fetchone()
    return dict(r) if r else None


def list_${noun}s(conn):
    return [dict(r) for r in conn.execute("SELECT * FROM ${table} ORDER BY id").fetchall()]

${bulkFunctions(noun, table)}

def validate(row):
    raise NotImplementedError


def summary(conn):
    raise NotImplementedError
`;
  const test = `import unittest
from src.db import connect
from src import ${noun}


class Test_${noun}(unittest.TestCase):
    def setUp(self):
        self.conn = connect()

    def test_crud(self):
        rid = ${noun}.create_${noun}(self.conn, "abc", 100, 2)
        row = ${noun}.get_${noun}(self.conn, rid)
        self.assertEqual(row["name"], "abc")
        self.assertEqual(len(${noun}.list_${noun}s(self.conn)), 1)

    def test_validate(self):
        # A row satisfying this module's rule validates True.
        good = {"name": "abcdef", "value_cents": 100, "quantity": 2}
        self.assertTrue(${noun}.validate(good))
        # A clearly-invalid row raises.
        bad = {"name": "abcdef", "value_cents": 100, "quantity": 2}
        bad_broken = dict(good)
        # break the specific rule: ${rule.desc}
        if not (${rule.check.replace(/row\['/g, "bad_broken['")}):
            pass
        # construct a violating row deterministically per rule
        viol = ${violatingRow(rule)}
        with self.assertRaises(ValueError):
            ${noun}.validate(viol)

    def test_summary(self):
        ${noun}.create_${noun}(self.conn, "abc", 200, 2)
        ${noun}.create_${noun}(self.conn, "def", 300, 4)
        s = ${noun}.summary(self.conn)
        self.assertEqual(s["count"], 2)
        self.assertEqual(s["total_value_cents"], 500)


if __name__ == "__main__":
    unittest.main()
`;
  return { noun, table, code, test, rule };
}

// A row that deterministically VIOLATES a given rule (for the test).
function violatingRow(rule) {
  const map = {
    "value_cents must be a multiple of 5": `{"name": "abcdef", "value_cents": 103, "quantity": 2}`,
    "quantity must be strictly positive": `{"name": "abcdef", "value_cents": 100, "quantity": 0}`,
    "name must be at least 3 characters": `{"name": "ab", "value_cents": 100, "quantity": 2}`,
    "value_cents must be <= 1_000_000": `{"name": "abcdef", "value_cents": 1000001, "quantity": 2}`,
    "quantity must be <= 10_000": `{"name": "abcdef", "value_cents": 100, "quantity": 10001}`,
    "name must be lowercase": `{"name": "ABCDEF", "value_cents": 100, "quantity": 2}`,
    "value_cents must be non-zero when quantity>0": `{"name": "abcdef", "value_cents": 0, "quantity": 2}`,
    "quantity must be even": `{"name": "abcdef", "value_cents": 100, "quantity": 3}`,
  };
  return map[rule.desc];
}

// ---- build ---------------------------------------------------------------
const resources = Array.from({ length: N }, (_, i) => resourceModule(i));

W("src/__init__.py", "");
W("src/util/__init__.py", "");
W(
  "src/util/time.py",
  `"""Time helpers. Use now_iso() everywhere for timestamps."""
from datetime import datetime, timezone

def now_iso():
    """UTC ISO-8601 timestamp. The ONLY approved way to get 'now' in this repo."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
`,
);

// db.py with a table per resource
const schema = resources
  .map(
    (r) => `CREATE TABLE IF NOT EXISTS ${r.table} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  value_cents INTEGER NOT NULL,
  quantity INTEGER NOT NULL,
  created_at TEXT NOT NULL
);`,
  )
  .join("\n");
W(
  "src/db.py",
  `"""SQLite data layer. Synchronous by design."""
import sqlite3

_SCHEMA = """
${schema}
"""

def connect(path=":memory:"):
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    conn.executescript(_SCHEMA)
    return conn
`,
);

for (const r of resources) {
  W(`src/${r.noun}.py`, r.code);
  W(`tests/test_${r.noun}.py`, r.test);
}
W("tests/__init__.py", "");

// SPEC.md — restates each module's rule (agent may cross-reference).
W(
  "SPEC.md",
  `# warehouse — specification\n\nPure Python stdlib service. Each resource module exposes CRUD plus \`validate(row)\` and \`summary(conn)\`.\n\n## Per-resource validation rules\n\nEach resource module has its OWN validation rule, documented in that module's\ndocstring (top of \`src/<name>.py\`). The rules DIFFER per module — there is no\ncentral list. You must open each module to read its specific rule before\nimplementing \`validate()\`.\n\n## Conventions\n\n- Timestamps: always via \`src/util/time.py:now_iso()\` (UTC ISO-8601). Never call datetime.now() directly.\n- Money: integer cents everywhere.\n- \`validate(row)\` returns True when valid, else raises ValueError.\n- \`summary(conn)\` returns {"count": int, "total_value_cents": int}.\n`,
);

W(
  "README.md",
  `# warehouse\n\nOrder/inventory service. Pure Python stdlib (sqlite3 + unittest), no third-party deps.\n\nRun tests:\n\n    python3 -m unittest discover -s tests -v\n\n${N} resource modules under src/, each with CRUD + two functions to implement (validate, summary). See SPEC.md for each module's validation rule (they differ per module).\n`,
);

// size report
let files = 0,
  bytes = 0;
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else {
      files++;
      bytes += fs.statSync(p).size;
    }
  }
};
walk(DEST);
console.log(
  `seed: ${N} resources, ${files} files, ${bytes.toLocaleString()} bytes (~${Math.round(bytes / 4).toLocaleString()} tokens)`,
);
