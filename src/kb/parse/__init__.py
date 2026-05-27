"""Document parsing — produces a list of typed elements with page + bbox metadata.

Cached by content_hash so re-running schema-driven stages NEVER re-parses.
"""

from kb.parse.parser import Element, parse_file

__all__ = ["Element", "parse_file"]
