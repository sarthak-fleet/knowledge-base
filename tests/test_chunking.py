"""Hierarchical chunker builds parent + child chunks and links them."""

from kb.parse import Element
from kb.vector.chunking import build_chunks


def _el(page: int, i: int, text: str) -> Element:
    return Element(id=f"el-{i}", type="NarrativeText", text=text, page=page, bbox=None, parent_id=None, metadata={})


def test_chunks_have_parents_and_pages() -> None:
    text = "Sentence one. " * 80   # forces multiple parents
    elements = [_el(1, i, text) for i in range(5)]
    parents, children = build_chunks(elements, parent_size=400, child_size=100, overlap=0)
    assert parents and children
    assert all(c.parent_id in {p.id for p in parents} for c in children)
    for p in parents:
        assert p.page_start == 1
        assert p.page_end == 1


def test_chunks_preserve_element_ids() -> None:
    elements = [_el(1, i, f"para {i}") for i in range(3)]
    parents, _ = build_chunks(elements, parent_size=10000, child_size=10000, overlap=0)
    assert parents
    # All element ids end up in some parent
    seen: set[str] = set()
    for p in parents:
        seen.update(p.element_ids)
    assert seen == {e.id for e in elements}
