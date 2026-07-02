"""ABC-conformance guard for the Hermes ``ContextEngine`` contract (#1042).

The conftest stub (``agent.context_engine.ContextEngine``) is an ``abc.ABC``
mirroring the real Hermes contract's abstract-method set. These tests prove:

1. the stub actually *enforces* the contract — an implementation missing an
   override cannot be instantiated. This guards against the stub silently
   regressing to a plain class, which would re-hide the missing-override bug
   that motivated #1042 (a plain-class stub makes ``TypeError`` impossible, so
   the whole guard becomes vacuous); and
2. ``LoreContextEngine`` *satisfies* the contract — it is concrete and
   instantiable, so ``register()`` (``__init__.py``) won't raise
   ``TypeError: Can't instantiate abstract class`` in production.

Residual gap (documented, not fixed here): this checks our engine against a
hand-maintained SNAPSHOT of the contract (hermes-agent==0.18.0), not live
upstream Hermes. Upstream adding a *new* abstract method is caught separately
by ``scripts/check_real_context_engine.py`` — the real-Hermes drift +
conformance check wired into CI by #1136 (and by the full-install
``packages/hermes/test-integration.sh``).
"""

import abc

import pytest

from tests.contract_spec import EXPECTED_ABSTRACT_METHODS


def test_stub_context_engine_is_an_enforcing_abc():
    from agent.context_engine import ContextEngine

    assert issubclass(ContextEngine, abc.ABC)
    # Exact set — flags any accidental add/remove of an abstract method in the
    # stub (forcing an intentional, reviewed update when the snapshot changes).
    assert ContextEngine.__abstractmethods__ == EXPECTED_ABSTRACT_METHODS


def test_incomplete_implementation_cannot_be_instantiated():
    """A subclass missing an override must raise TypeError.

    This is the mutation guard: if the stub reverts to a plain (non-ABC) class,
    ``Incomplete()`` would succeed and this test fails.
    """
    from agent.context_engine import ContextEngine

    class Incomplete(ContextEngine):
        # Overrides only ONE of the four abstract methods.
        @property
        def name(self) -> str:
            return "incomplete"

    with pytest.raises(TypeError):
        Incomplete()


def test_lore_engine_satisfies_the_contract():
    from agent.context_engine import ContextEngine

    from lore_hermes.engine import LoreContextEngine

    assert issubclass(LoreContextEngine, ContextEngine)
    # Instantiating proves every abstract method is overridden — this would
    # raise ``TypeError`` otherwise. It is the conformance signal #1042 adds
    # (previously a no-op, because the stub base enforced nothing).
    engine = LoreContextEngine()
    assert not type(engine).__abstractmethods__  # fully concrete
