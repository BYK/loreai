"""Deterministic embedding retrieval pilot with FTS-only and RRF controls.

This approximates one part of Lore's recall path; it is not an end-task eval.
"""
import argparse
import json
import math
import re
import sqlite3
import statistics
from pathlib import Path


def fts_rank(documents, text):
    con = sqlite3.connect(":memory:")
    con.execute("CREATE VIRTUAL TABLE memory USING fts5(id UNINDEXED, content)")
    con.executemany("INSERT INTO memory(id, content) VALUES (?, ?)",
                    [(doc["id"], doc["text"]) for doc in documents])
    tokens = re.findall(r"[a-zA-Z][a-zA-Z0-9_]*", text.lower())
    # A simple safe OR control. Lore uses source-specific FTS queries and
    # relaxation, so these FTS scores must not be described as Lore end-to-end.
    terms = list(dict.fromkeys(t for t in tokens if len(t) > 1))
    if not terms:
        return []
    query = " OR ".join(f'"{term}"' for term in terms)
    return [row[0] for row in con.execute(
        "SELECT id FROM memory WHERE memory MATCH ? ORDER BY bm25(memory) LIMIT 10", (query,))]


def vector_rank(query, documents):
    norm = math.sqrt(sum(x * x for x in query))
    if norm == 0:
        raise ValueError("zero-length query vector")
    scored = []
    for key, doc in documents.items():
        if len(query) != len(doc):
            raise ValueError(f"dimension mismatch for {key}: {len(query)} != {len(doc)}")
        doc_norm = math.sqrt(sum(x * x for x in doc))
        if doc_norm == 0:
            raise ValueError(f"zero-length document vector: {key}")
        sim = sum(a * b for a, b in zip(query, doc)) / (norm * doc_norm)
        scored.append((sim, key))
    return [key for _, key in sorted(scored, key=lambda pair: (-pair[0], pair[1]))]


def fuse(fts, vector, weight=1.5):
    scores = {}
    for rank, key in enumerate(fts):
        scores[key] = scores.get(key, 0) + 1 / (60 + rank)
    for rank, key in enumerate(vector[:10]):
        scores[key] = scores.get(key, 0) + weight / (60 + rank)
    return sorted(scores, key=lambda key: (-scores[key], key))


def metrics(queries, results):
    n = len(queries)
    summary = {"count": n}
    for k in (1, 3, 5):
        summary[f"recall@{k}"] = round(sum(
            len(set(results[q["id"]][:k]) & set(q["relevant"])) / len(q["relevant"])
            for q in queries) / n, 4)
    summary["mrr@10"] = round(sum(
        next((1 / (rank + 1) for rank, item in enumerate(results[q["id"]][:10])
              if item in q["relevant"]), 0)
        for q in queries) / n, 4)
    summary["stale@5"] = round(sum(
        bool(set(results[q["id"]][:5]) & set(q.get("stale", [])))
        for q in queries) / n, 4)
    summary["anchored@5"] = round(sum(
        any(doc_id in results[q["id"]][:5] for doc_id in q["relevant"])
        for q in queries if q.get("anchor")) / sum(bool(q.get("anchor")) for q in queries), 4)
    summary["perQuery"] = [{"id": q["id"], "top5": results[q["id"]][:5],
                            "relevant": q["relevant"], "stale": q.get("stale", [])}
                           for q in queries]
    return summary


def validate_vectors(data, cases):
    dimension = data["dimensions"]
    if dimension not in (256, 512, 768, 1024, 2048):
        raise ValueError(f"unexpected dimension {dimension}")
    for kind in ("documents", "queries"):
        expected = {item["id"] for item in cases[kind]}
        if set(data[kind]) != expected:
            raise ValueError(f"{kind} IDs do not match the fixture")
        for key, vec in data[kind].items():
            if len(vec) != dimension or not all(math.isfinite(v) for v in vec):
                raise ValueError(f"invalid vector for {key}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", type=Path)
    parser.add_argument("vectors", nargs="*", type=Path)
    parser.add_argument("--mix-voyage", action="store_true",
                        help="compare local/hosted Voyage 4 document-query cross pairs")
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text())
    queries = cases["queries"]
    fts = {q["id"]: fts_rank(cases["documents"], q["text"]) for q in queries}
    report = {"fixture": cases["origin"], "ftsOnly": metrics(queries, fts), "runs": []}
    inputs = []
    for path in args.vectors:
        data = json.loads(path.read_text())
        validate_vectors(data, cases)
        inputs.append(data)
        vector = {q["id"]: vector_rank(data["queries"][q["id"]], data["documents"])
                  for q in queries}
        fused = {q["id"]: fuse(fts[q["id"]], vector[q["id"]]) for q in queries}
        report["runs"].append({"model": data["model"], "dimensions": data["dimensions"],
                               "revision": data.get("revision"), "host": data["host"],
                               "timings": {**{k: v for k, v in data["timings"].items() if k != "latencyMs"},
                                           "p50p95Ms": {kind: [round(statistics.median(values), 2),
                                                                round(sorted(values)[math.ceil(0.95 * len(values)) - 1], 2)]
                                                        for kind, values in data["timings"]["latencyMs"].items()}},
                               "vectorOnly": metrics(queries, vector),
                               "ftsVectorRrfProxy": metrics(queries, fused)})
    if args.mix_voyage:
        for docs in inputs:
            for qvec in inputs:
                if docs is qvec:
                    continue
                allowed = ("voyageai/voyage-4-nano", "voyage-4", "voyage-4-lite",
                           "voyage-4-large")
                if docs["model"] not in allowed or qvec["model"] not in allowed:
                    raise ValueError("mixed search requires explicit Voyage 4 general-family models")
                if docs["dimensions"] != qvec["dimensions"]:
                    raise ValueError("mixed Voyage vector dimensions must match")
                mixed = {q["id"]: vector_rank(qvec["queries"][q["id"]], docs["documents"])
                         for q in queries}
                report["runs"].append({"documentsModel": docs["model"],
                                       "queriesModel": qvec["model"],
                                       "dimensions": docs["dimensions"],
                                       "vectorOnly": metrics(queries, mixed),
                                       "ftsVectorRrfProxy": metrics(
                                           queries, {q["id"]: fuse(fts[q["id"]], mixed[q["id"]])
                                                     for q in queries})})
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
