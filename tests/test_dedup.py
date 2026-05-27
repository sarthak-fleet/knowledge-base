"""Chunk-level dedup: normalize_text + content_hash + canonical_hash."""

from __future__ import annotations

from kb.vector.dedup import canonical_hash, content_hash, normalize_text


def test_normalize_is_case_and_whitespace_insensitive() -> None:
    a = "The   QUICK brown fox.\n\nJumps over the lazy dog!"
    b = "the quick brown fox jumps over the lazy dog"
    assert normalize_text(a) == b


def test_normalize_strips_punctuation_runs() -> None:
    assert normalize_text("hello, world!!!") == "hello world"
    assert normalize_text("foo --- bar") == "foo bar"


def test_normalize_handles_unicode_and_empty() -> None:
    assert normalize_text("") == ""
    # NFKC: half-width / full-width ASCII collapse
    assert normalize_text("ＡＢＣ") == "abc"


def test_content_hash_stable_across_formatting() -> None:
    a = "The Apache 2.0 License grants a patent license to the licensee."
    b = "the apache 2.0 license   grants a patent license to the licensee"
    c = "The Apache 2.0 License grants a patent\nlicense to the licensee!"
    assert content_hash(a) == content_hash(b) == content_hash(c)


def test_content_hash_distinguishes_different_text() -> None:
    a = "Apache grants a patent license"
    b = "Apache imposes a patent license restriction"
    assert content_hash(a) != content_hash(b)


def test_canonical_hash_joins_elements() -> None:
    elements_a = ["First paragraph.", "Second paragraph."]
    elements_b = ["FIRST PARAGRAPH", "second paragraph"]
    # Different formatting, same canonical content → same hash.
    assert canonical_hash(elements_a) == canonical_hash(elements_b)


def test_canonical_hash_distinguishes_order() -> None:
    a = ["Para A", "Para B"]
    b = ["Para B", "Para A"]
    assert canonical_hash(a) != canonical_hash(b)
