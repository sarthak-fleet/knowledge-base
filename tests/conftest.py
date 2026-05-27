"""Pytest fixtures shared across unit tests."""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

# Ensure config loads even without .env present.
os.environ.setdefault("AI_API_KEY", "test")
os.environ.setdefault("AI_BASE_URL", "http://localhost:0")
os.environ.setdefault("AI_MODEL", "test-model")
