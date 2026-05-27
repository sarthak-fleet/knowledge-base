"""Page-windowing covers the doc, overlaps as configured, and handles paged + non-paged input."""

from kb.extract.windowing import page_windows
from kb.parse import Element


def _el(page: int, i: int) -> Element:
    return Element(
        id=f"el-{i}",
        type="NarrativeText",
        text=f"page {page} text",
        page=page,
        bbox=None,
        parent_id=None,
        metadata={},
    )


def test_paged_windows_cover_all_pages_with_overlap() -> None:
    from itertools import pairwise

    elements = [_el(p, i) for i in range(50) for p in [1 + (i % 20)]]
    wins = list(page_windows(elements, window_pages=8, overlap_pages=1))
    covered = set()
    for p0, p1, _ in wins:
        for p in range(p0, p1 + 1):
            covered.add(p)
    assert covered == set(range(1, 21))
    # consecutive windows overlap by 1 page
    for a, b in pairwise(wins):
        if b[0] <= a[1]:
            assert b[0] >= a[1] - 1


def test_xlsx_like_input_yields_single_window() -> None:
    elements = [_el(0, i) for i in range(10)]
    wins = list(page_windows(elements, window_pages=8, overlap_pages=1))
    assert len(wins) == 1
    assert wins[0][0] == 0 and wins[0][1] == 0


def test_empty_input() -> None:
    assert list(page_windows([], window_pages=8, overlap_pages=1)) == []
