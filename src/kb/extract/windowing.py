"""Page-bounded windowing so long documents don't lose cross-boundary context."""

from __future__ import annotations

from collections.abc import Iterator

from kb.parse import Element


def _max_page(elements: list[Element]) -> int:
    return max((e.page for e in elements), default=0)


def page_windows(
    elements: list[Element],
    *,
    window_pages: int = 8,
    overlap_pages: int = 1,
) -> Iterator[tuple[int, int, list[Element]]]:
    """Yield (page_start, page_end, elements_in_window) tuples.

    Windows overlap by `overlap_pages` to avoid losing entities that straddle
    a window boundary.  For non-paged formats (e.g. xlsx where page=0), a
    single window covers everything.
    """
    if not elements:
        return
    max_p = _max_page(elements)
    if max_p == 0:
        yield 0, 0, list(elements)
        return
    p = 1
    while p <= max_p:
        end = min(p + window_pages - 1, max_p)
        bucket = [e for e in elements if p <= e.page <= end]
        if bucket:
            yield p, end, bucket
        if end >= max_p:
            break
        p = end + 1 - overlap_pages
        if p < 1:
            p = 1
