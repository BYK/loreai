"""Tests for gateway discovery logic."""

import os
from unittest.mock import patch

import pytest


class TestFindGateway:
    """Test gateway discovery without network calls."""

    def test_returns_none_when_no_gateway(self):
        """No env vars, no running gateway → None."""
        with patch.dict(os.environ, {}, clear=True), \
             patch("lore_hermes.gateway._probe", return_value=False):
            from lore_hermes.gateway import find_gateway

            assert find_gateway() is None

    def test_prefers_remote_url(self):
        """LORE_REMOTE_URL takes highest priority."""
        with patch.dict(os.environ, {"LORE_REMOTE_URL": "https://remote.example.com"}), \
             patch("lore_hermes.gateway._probe", return_value=True):
            from lore_hermes.gateway import find_gateway

            assert find_gateway() == "https://remote.example.com"

    def test_prefers_gateway_url_over_default_ports(self):
        """LORE_GATEWAY_URL takes priority over default port probing."""
        with patch.dict(os.environ, {"LORE_GATEWAY_URL": "http://127.0.0.1:9999"}), \
             patch("lore_hermes.gateway._probe", return_value=True):
            from lore_hermes.gateway import find_gateway

            assert find_gateway() == "http://127.0.0.1:9999"

    def test_probes_default_ports(self):
        """Falls back to probing default ports."""
        def probe_side_effect(url):
            return url == "http://127.0.0.1:3207"

        with patch.dict(os.environ, {}, clear=True), \
             patch("lore_hermes.gateway._probe", side_effect=probe_side_effect):
            from lore_hermes.gateway import find_gateway

            assert find_gateway() == "http://127.0.0.1:3207"

    def test_probes_fallback_port(self):
        """Tries port 5673 when 3207 is not responding."""
        def probe_side_effect(url):
            return url == "http://127.0.0.1:5673"

        with patch.dict(os.environ, {}, clear=True), \
             patch("lore_hermes.gateway._probe", side_effect=probe_side_effect):
            from lore_hermes.gateway import find_gateway

            assert find_gateway() == "http://127.0.0.1:5673"


class TestEnsureGateway:
    """Test gateway startup logic."""

    def test_returns_existing_gateway(self):
        """If gateway is already running, returns its URL without starting."""
        with patch("lore_hermes.gateway.find_gateway", return_value="http://127.0.0.1:3207"):
            from lore_hermes.gateway import ensure_gateway

            assert ensure_gateway() == "http://127.0.0.1:3207"

    def test_returns_none_when_no_binary(self):
        """No lore binary on PATH → None."""
        with patch("lore_hermes.gateway.find_gateway", return_value=None), \
             patch("shutil.which", return_value=None):
            from lore_hermes.gateway import ensure_gateway

            assert ensure_gateway() is None


class TestDeriveSessionId:
    """Test session ID derivation."""

    def test_hashes_provided_session_id_to_hex(self):
        """Provided session IDs are always hashed to hex for gateway compatibility."""
        from lore_hermes import _derive_session_id

        result = _derive_session_id("my-session-123")
        assert isinstance(result, str)
        assert len(result) == 16
        # Must be lowercase hex (gateway regex requires [a-f0-9]{8,64})
        assert all(c in "0123456789abcdef" for c in result)
        # Different input → different hash
        assert _derive_session_id("other-session") != result

    def test_derives_from_env_when_none(self):
        from lore_hermes import _derive_session_id

        result = _derive_session_id(None)
        assert isinstance(result, str)
        assert len(result) == 16
        assert all(c in "0123456789abcdef" for c in result)

    def test_derives_from_env_when_empty(self):
        from lore_hermes import _derive_session_id

        result = _derive_session_id("")
        assert isinstance(result, str)
        assert len(result) == 16
        assert all(c in "0123456789abcdef" for c in result)
