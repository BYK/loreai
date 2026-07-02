"""Unit coverage for ``scripts/check_real_context_engine.py`` (#1136).

These run under the normal (stubbed) pytest suite, so they exercise the pure
diff/conformance helpers and — importantly — prove the stub-detection guard in
``main()`` refuses to treat the conftest stub as a real hermes-agent install
(which would make the whole real-ABC check a vacuous pass). The true
integration path (real drift/conformance against an installed hermes-agent) is
exercised by the CI ``hermes-real-abc`` job, not here.
"""

import sys
from pathlib import Path

# The check script lives outside the importable package (it's CI tooling, not
# shipped), so load it by adding scripts/ to sys.path.
_SCRIPTS = Path(__file__).resolve().parent.parent / "scripts"
if str(_SCRIPTS) not in sys.path:
    sys.path.insert(0, str(_SCRIPTS))

import check_real_context_engine as chk  # noqa: E402


def test_diff_abstract_methods_no_drift():
    s = frozenset({"a", "b"})
    assert chk.diff_abstract_methods(s, s) == ([], [])


def test_diff_abstract_methods_reports_added_and_removed():
    real = frozenset({"name", "compress", "brand_new"})
    expected = frozenset({"name", "compress", "gone"})
    added, removed = chk.diff_abstract_methods(real, expected)
    assert added == ["brand_new"]
    assert removed == ["gone"]


def test_evaluate_engine_accepts_a_complete_subclass():
    # LoreContextEngine overrides every abstract method of the (stub) ABC.
    from lore_hermes.engine import LoreContextEngine

    ok, detail = chk.evaluate_engine(LoreContextEngine)
    assert ok is True
    assert detail == ""


def test_evaluate_engine_rejects_an_incomplete_subclass():
    from agent.context_engine import ContextEngine

    class Incomplete(ContextEngine):
        # Overrides only ONE of the abstract methods.
        @property
        def name(self) -> str:
            return "incomplete"

    ok, detail = chk.evaluate_engine(Incomplete)
    assert ok is False
    assert "TypeError" in detail


def test_main_skips_when_only_the_stub_is_present():
    """The load-bearing guard: run under the conftest stub (no real
    hermes-agent), ``main()`` must SKIP rather than compare the stub against
    its own snapshot. If the ``__file__`` guard were removed, ``main()`` would
    instead find no drift + a conforming engine and return ``EXIT_OK`` — a
    false pass. Asserting SKIP kills that mutation.
    """
    assert chk.main() == chk.EXIT_SKIP
