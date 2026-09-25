"""Official SentenceTransformers pathway; requires torch and sentence-transformers."""
import argparse
import json
import os
import platform
import resource
import time
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("cases", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--dimensions", type=int, choices=[256, 512, 1024, 2048], required=True)
    parser.add_argument("--revision", default="67fabc9bef010dabc5f6024aa1b1b6b93410426f")
    args = parser.parse_args()

    # Set CPU pools before importing torch. LORE_EVAL_THREADS=1 or 2 is useful
    # on a four-core machine; report it alongside timings.
    threads = os.getenv("LORE_EVAL_THREADS", "2")
    os.environ["OMP_NUM_THREADS"] = threads
    os.environ["MKL_NUM_THREADS"] = threads
    from sentence_transformers import SentenceTransformer
    import torch

    torch.set_num_threads(int(threads))
    cases = json.loads(args.cases.read_text())
    start = time.perf_counter()
    cpu_start = time.process_time()
    model = SentenceTransformer("voyageai/voyage-4-nano", trust_remote_code=True,
                                revision=args.revision, truncate_dim=args.dimensions,
                                device="cpu")
    load_ms = (time.perf_counter() - start) * 1000
    latencies = {"document": [], "query": []}

    def encode(items, kind):
        result = {}
        for item in items:
            t = time.perf_counter()
            # encode_query/document attach the model's own task-specific prompts.
            vector = (model.encode_query(item["text"]) if kind == "query"
                      else model.encode_document(item["text"]))
            if len(vector) != args.dimensions:
                raise ValueError(f"expected {args.dimensions} dimensions; got {len(vector)}")
            result[item["id"]] = vector.tolist()
            latencies[kind].append((time.perf_counter() - t) * 1000)
        return result

    documents = encode(cases["documents"], "document")
    queries = encode(cases["queries"], "query")
    args.output.write_text(json.dumps({
        "model": "voyageai/voyage-4-nano", "revision": args.revision,
        "provider": "local", "dimensions": args.dimensions,
        "documents": documents, "queries": queries,
        "timings": {"loadMs": load_ms, "elapsedMs": (time.perf_counter() - start) * 1000,
                    "cpuMs": (time.process_time() - cpu_start) * 1000,
                    "peakRssBytes": resource.getrusage(resource.RUSAGE_SELF).ru_maxrss * 1024,
                    "latencyMs": latencies},
        "host": {"python": platform.python_version(), "cpu": platform.processor(),
                 "cores": os.cpu_count(), "memoryBytes": None, "threads": int(threads),
                 "torch": torch.__version__},
    }) + "\n")


if __name__ == "__main__":
    main()
