"""Tests for the LoreContextEngine passthrough."""

import pytest


# Since the engine depends on Hermes's agent.context_engine ABC which
# isn't available in this monorepo (it's a Hermes internal), we test
# the engine's core logic directly without importing the ABC.


class TestLoreContextEngine:
    """Test the engine's core behavior without the Hermes ABC dependency."""

    def _make_engine(self):
        """Create a minimal engine instance for testing."""
        from lore_hermes.engine import LoreContextEngine

        return LoreContextEngine()

    def test_name(self):
        engine = self._make_engine()
        assert engine.name == "lore"

    def test_should_compress_always_false(self):
        engine = self._make_engine()
        assert engine.should_compress() is False
        assert engine.should_compress(prompt_tokens=100_000) is False
        assert engine.should_compress(prompt_tokens=999_999) is False

    def test_should_compress_preflight_always_false(self):
        engine = self._make_engine()
        assert engine.should_compress_preflight([]) is False
        assert engine.should_compress_preflight([{"role": "user", "content": "hi"}]) is False

    def test_compress_returns_messages_unmodified(self):
        engine = self._make_engine()
        msgs = [
            {"role": "system", "content": "You are helpful."},
            {"role": "user", "content": "Hello"},
            {"role": "assistant", "content": "Hi there!"},
        ]
        result = engine.compress(msgs)
        assert result is msgs  # Same reference — no copy

    def test_compress_with_focus_topic(self):
        engine = self._make_engine()
        msgs = [{"role": "user", "content": "test"}]
        result = engine.compress(msgs, focus_topic="debugging")
        assert result is msgs

    def test_update_from_response(self):
        engine = self._make_engine()
        engine.update_from_response({
            "prompt_tokens": 5000,
            "completion_tokens": 1200,
        })
        assert engine.last_prompt_tokens == 5000
        assert engine.last_completion_tokens == 1200
        assert engine.last_total_tokens == 6200

    def test_update_from_response_missing_keys(self):
        engine = self._make_engine()
        engine.update_from_response({})
        assert engine.last_prompt_tokens == 0
        assert engine.last_completion_tokens == 0
        assert engine.last_total_tokens == 0

    def test_get_status(self):
        engine = self._make_engine()
        engine.update_from_response({
            "prompt_tokens": 3000,
            "completion_tokens": 800,
        })
        status = engine.get_status()
        assert status["engine"] == "lore"
        assert status["compression_delegated"] is True
        assert status["prompt_tokens"] == 3000
        assert status["completion_tokens"] == 800
        assert status["total_tokens"] == 3800
        assert status["compression_count"] == 0
