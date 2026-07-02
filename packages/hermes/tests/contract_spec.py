"""Single source of truth for the Hermes ``ContextEngine`` ABC snapshot.

Both the stubbed unit guard (``test_contract.py`` / ``conftest.py``) and the
real-Hermes drift check (``scripts/check_real_context_engine.py``, wired into
CI by #1136) compare against the values here, so there is exactly one place to
update when upstream Hermes changes its abstract contract.

``EXPECTED_ABSTRACT_METHODS`` is a snapshot of
``agent.context_engine.ContextEngine.__abstractmethods__`` as of
``hermes-agent==HERMES_AGENT_VERSION``. Concrete upstream hooks (e.g.
``should_compress_preflight``, ``get_status``) are NOT abstract there and are
intentionally excluded — listing them would make our stub stricter than
reality.

When the real-ABC CI check reports drift, update BOTH constants (and add/remove
the corresponding override in ``lore_hermes.engine.LoreContextEngine``).
"""

# The hermes-agent release this repo's abstract-method snapshot mirrors.
HERMES_AGENT_VERSION = "0.18.0"

# Snapshot of ContextEngine.__abstractmethods__ at HERMES_AGENT_VERSION.
EXPECTED_ABSTRACT_METHODS = frozenset(
    {"name", "should_compress", "compress", "update_from_response"}
)
