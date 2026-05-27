"""Migration loader — split statements correctly without firing them."""

from kb.storage.init_db import _split_statements


def test_simple_split() -> None:
    sql = "CREATE TABLE a();\nCREATE TABLE b();"
    stmts = _split_statements(sql)
    assert stmts == ["CREATE TABLE a();", "CREATE TABLE b();"]


def test_multiline_and_comments_stripped() -> None:
    sql = """
    -- header comment
    CREATE EXTENSION IF NOT EXISTS vector;
    -- another comment
    CREATE TABLE t (
      id INT PRIMARY KEY,
      name TEXT
    );
    """
    stmts = _split_statements(sql)
    assert len(stmts) == 2
    assert "vector" in stmts[0]
    assert "PRIMARY KEY" in stmts[1]
