"""Check a third-party quantized export against official Voyage Nano vectors."""
import argparse
import json
import math
import statistics
from pathlib import Path


def cosine(a, b):
    if len(a) != len(b):
        raise ValueError("vector dimension mismatch")
    denom = math.sqrt(sum(x * x for x in a) * sum(x * x for x in b))
    if not denom:
        raise ValueError("zero vector")
    return sum(x * y for x, y in zip(a, b)) / denom


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("reference", type=Path)
    parser.add_argument("candidate", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    ref = json.loads(args.reference.read_text())
    q8 = json.loads(args.candidate.read_text())
    if ref["model"] != "voyageai/voyage-4-nano" or ref["dimensions"] != 1024:
        raise ValueError("expected official 1024d Nano reference")
    if q8["model"] != "jsonMartin/voyage-4-nano-ONNX" or q8["dimensions"] != 1024:
        raise ValueError("expected 1024d ONNX q8 candidate")
    scores = {}
    for kind in ("documents", "queries"):
        if ref[kind].keys() != q8[kind].keys():
            raise ValueError("fixture item IDs differ")
        scores[kind] = {key: cosine(vec, q8[kind][key])
                        for key, vec in ref[kind].items()}
    values = [x for group in scores.values() for x in group.values()]
    result = {"meanCosine": statistics.mean(values), "minCosine": min(values),
              "byId": scores, "referenceModel": ref["model"],
              "candidateModel": q8["model"]}
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(f"ONNX INT8 vs official BF16: mean cosine {result['meanCosine']:.4f}; "
          f"minimum {result['minCosine']:.4f}")
    # Do not interpret retrieval and RSS as a viable substitute if the
    # third-party export is not preserving the official vector space.
    if result["meanCosine"] < 0.90 or result["minCosine"] < 0.80:
        raise ValueError("ONNX output disagrees with official Nano; reject candidate")


if __name__ == "__main__":
    main()
