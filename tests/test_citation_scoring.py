"""Citation precision/recall used by the eval harness."""

from kb.eval.run import _citation_pr


def test_all_match() -> None:
    p, r, f1 = _citation_pr([{"filename": "NVDA_10-K_2024.pdf"}], ["NVDA_10-K"])
    assert p == 1.0 and r == 1.0 and f1 == 1.0


def test_partial_match() -> None:
    p, r, _f1 = _citation_pr(
        [{"filename": "AAPL_10-Q_2024.pdf"}, {"filename": "NVDA_10-K_2024.pdf"}],
        ["NVDA_10-K"],
    )
    assert 0 < p < 1 and r == 1.0


def test_no_predictions() -> None:
    p, r, f1 = _citation_pr([], ["NVDA_10-K"])
    assert (p, r, f1) == (0.0, 0.0, 0.0)


def test_no_expectations() -> None:
    p, r, f1 = _citation_pr([], [])
    assert (p, r, f1) == (1.0, 1.0, 1.0)
