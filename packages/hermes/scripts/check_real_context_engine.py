#!/usr/bin/env python3
"""Real-``hermes-agent`` ContextEngine ABC drift + conformance check (#1136).

The unit suite (``packages/hermes/tests``) runs against a hand-maintained stub
of ``agent.context_engine.ContextEngine`` injected by ``conftest.py``. That
stub mirrors a SNAPSHOT of the real contract, so it cannot catch *upstream*
drift: if a future ``hermes-agent`` adds/renames an abstract method,
``LoreContextEngine`` would raise ``TypeError: Can't instantiate abstract
class ...`` in production while the stubbed suite stays green.

This script closes that gap. It runs OUTSIDE pytest (so ``conftest.py`` never
injects the stub) against a real ``hermes-agent`` install and performs two
checks:

1. **Snapshot drift** — ``ContextEngine.__abstractmethods__`` must equal the
   pinned ``EXPECTED_ABSTRACT_METHODS`` snapshot. A mismatch means upstream
   changed the contract; update ``tests/contract_spec.py`` (and the stub /
   engine) accordingly.
2. **Conformance** — ``LoreContextEngine()`` must instantiate (every abstract
   method overridden), proving ``register()`` won't raise in production.

Exit codes:
    0  OK — snapshot matches and the engine conforms.
    1  FAIL — real drift or a conformance break (actionable, should fail CI).
    2  SKIP — real ``hermes-agent`` is not importable (or only the test stub is
       present). The CI wiring treats this as a non-fatal skip.
"""

from __future__ import annotations

import sys
from pathlib import Path

# packages/hermes — so ``tests.contract_spec`` (and an editable ``lore_hermes``)
# resolve when this script is run directly (`python .../check_real_context_engine.py`).
HERMES_ROOT = Path(__file__).resolve().parents[1]

EXIT_OK = 0
EXIT_FAIL = 1
EXIT_SKIP = 2


def diff_abstract_methods(
    real: frozenset[str], expected: frozenset[str]
) -> tuple[list[str], list[str]]:
    """Return ``(added, removed)`` — abstract methods present upstream but not
    in the snapshot, and vice-versa. Empty/empty means no drift."""
    return sorted(real - expected), sorted(expected - real)


def evaluate_engine(engine_factory) -> tuple[bool, str]:
    """Instantiate the engine and confirm it is fully concrete.

    Returns ``(ok, detail)``. ``ok`` is False (with a human-readable ``detail``)
    when instantiation raises ``TypeError`` (an abstract method is unoverridden)
    or the class still reports ``__abstractmethods__``.
    """
    try:
        engine = engine_factory()
    except TypeError as exc:
        return False, f"instantiation raised TypeError: {exc}"
    remaining = getattr(type(engine), "__abstractmethods__", frozenset())
    if remaining:
        return False, f"still abstract: {sorted(remaining)}"
    return True, ""


def _installed_version() -> str:
    try:
        from importlib.metadata import version

        return version("hermes-agent")
    except Exception:  # pragma: no cover - best-effort label only
        return "unknown"


def main() -> int:
    if str(HERMES_ROOT) not in sys.path:
        sys.path.insert(0, str(HERMES_ROOT))

    # 1. Real ContextEngine must be importable. Missing → SKIP (env issue, not
    #    a code failure).
    try:
        import agent.context_engine as ce
    except ImportError as exc:
        print(
            f"SKIP: real hermes-agent not importable ({exc}). "
            "Install it (`pip install hermes-agent`) to run this check.",
            file=sys.stderr,
        )
        return EXIT_SKIP

    # Guard: make sure we got the REAL module, not the conftest stub. The stub
    # is a synthetic ``types.ModuleType`` with no ``__file__``; a real installed
    # module always has one. Without this, running under pytest would compare
    # the stub against its own snapshot (a vacuous pass).
    if getattr(ce, "__file__", None) is None:
        print(
            "SKIP: agent.context_engine has no __file__ — this looks like the "
            "test stub, not a real hermes-agent install.",
            file=sys.stderr,
        )
        return EXIT_SKIP

    from tests.contract_spec import EXPECTED_ABSTRACT_METHODS, HERMES_AGENT_VERSION

    installed = _installed_version()
    real_abstract = frozenset(ce.ContextEngine.__abstractmethods__)

    # 2. Snapshot-drift check.
    added, removed = diff_abstract_methods(real_abstract, EXPECTED_ABSTRACT_METHODS)
    if added or removed:
        print(
            f"FAIL: ContextEngine abstract-method drift — installed "
            f"hermes-agent=={installed} diverges from the pinned snapshot "
            f"(hermes-agent=={HERMES_AGENT_VERSION}).",
            file=sys.stderr,
        )
        if added:
            print(f"  added upstream (need overrides): {added}", file=sys.stderr)
        if removed:
            print(f"  removed upstream (drop from snapshot): {removed}", file=sys.stderr)
        print(
            "  → update EXPECTED_ABSTRACT_METHODS in "
            "packages/hermes/tests/contract_spec.py and, if new methods were "
            "added, override them in lore_hermes.engine.LoreContextEngine.",
            file=sys.stderr,
        )
        return EXIT_FAIL

    # 3. Conformance check against the real ABC.
    from lore_hermes.engine import LoreContextEngine

    ok, detail = evaluate_engine(LoreContextEngine)
    if not ok:
        print(
            f"FAIL: LoreContextEngine does not satisfy the real hermes-agent=="
            f"{installed} ContextEngine ABC — {detail}.",
            file=sys.stderr,
        )
        return EXIT_FAIL

    print(
        f"OK: LoreContextEngine satisfies the real ContextEngine ABC and the "
        f"pinned snapshot matches (hermes-agent=={installed}, abstract methods: "
        f"{sorted(real_abstract)})."
    )
    return EXIT_OK


if __name__ == "__main__":
    sys.exit(main())
