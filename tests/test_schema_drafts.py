from __future__ import annotations

from types import SimpleNamespace

from kb.api.routes import schemas as schemas_route


async def test_apply_draft_applies_schema_and_enqueues_staged_files(monkeypatch) -> None:
    async def fake_get_schema_draft(draft_id: str, *, project: str):
        return {
            "id": draft_id,
            "project": project,
            "domain": "research-papers",
            "name": "inferred",
            "spec": {"domain": "research-papers", "name": "inferred", "entities": []},
            "status": "pending",
            "staged_file_ids": ["file-1", "file-2"],
            "source": "sample_files",
            "sample_count": 2,
            "errors": [],
        }

    async def fake_apply_schema_dict(**kwargs):
        assert kwargs["project"] == "personal"
        assert kwargs["domain"] == "research-papers"
        return SimpleNamespace(domain="research-papers", name="inferred", version=3)

    async def fake_update_schema_draft_status(draft_id: str, *, project: str, status: str):
        assert status == "applied"
        return {"id": draft_id, "project": project, "domain": "research-papers", "status": status}

    async def fake_enqueue_files(**kwargs):
        assert kwargs["file_ids"] == ["file-1", "file-2"]
        return 2

    monkeypatch.setattr(schemas_route.repo, "get_schema_draft", fake_get_schema_draft)
    monkeypatch.setattr(schemas_route, "apply_schema_dict", fake_apply_schema_dict)
    monkeypatch.setattr(
        schemas_route.repo, "update_schema_draft_status", fake_update_schema_draft_status
    )

    from kb.jobs import enqueue as enqueue_mod

    monkeypatch.setattr(enqueue_mod, "enqueue_files", fake_enqueue_files)

    out = await schemas_route.apply_draft(
        "draft-1",
        schemas_route.ApplyDraftIn(project="personal", ingest_staged_files=True),
    )

    assert out["version"] == 3
    assert out["draft_status"] == "applied"
    assert out["enqueued"] == 2


async def test_discard_draft_marks_discarded(monkeypatch) -> None:
    async def fake_update_schema_draft_status(draft_id: str, *, project: str, status: str):
        return {"id": draft_id, "project": project, "domain": "notes", "status": status}

    monkeypatch.setattr(
        schemas_route.repo, "update_schema_draft_status", fake_update_schema_draft_status
    )

    out = await schemas_route.discard_draft(
        "draft-1",
        schemas_route.DraftProjectIn(project="personal"),
    )

    assert out["project"] == "personal"
    assert out["status"] == "discarded"
