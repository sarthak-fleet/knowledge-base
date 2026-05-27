"""Layered configuration: defaults < domain overrides < env."""

from kb.config.settings import Settings, get_settings

__all__ = ["Settings", "get_settings"]
