from __future__ import annotations

from kb.api.routes import infer as infer_route
from kb.parse import Element
from kb.schema.model import DomainSchema, EntityType, FieldSpec


class FakeUpload:
    filename = "paper.txt"
    content_type = "text/plain"

    async def read(self) -> bytes:
        return b"Alpha therapeutic note. Beta trial design."


def _el(text: str, idx: int) -> Element:
    return Element(
        id=f"el-{idx}",
        type="NarrativeText",
        text=text,
        page=1,
        bbox=None,
        parent_id=None,
        metadata={},
    )


def test_sample_texts_from_elements_batches_text() -> None:
    samples = infer_route._sample_texts_from_elements(
        [_el("first paragraph", 1), _el("second paragraph", 2)],
        sample_count=3,
        max_chars=24,
    )

    assert samples == ["first paragraph", "second paragraph"]


async def test_infer_from_files_stages_and_infers(monkeypatch) -> None:
    calls: list[tuple[str, str]] = []

    async def fake_put_raw_file(*, domain: str, filename: str, blob: bytes) -> tuple[str, str]:
        assert domain == "research-papers"
        assert filename == "paper.txt"
        assert blob
        return "raw/paper.txt", "abc123"

    async def fake_upsert_domain(name: str, description=None, project: str = "default"):
        calls.append((project, name))
        return {"project": project, "name": name, "description": description}

    async def fake_register_file(**kwargs):
        return {
            "id": "file-1",
            "project": kwargs["project"],
            "domain": kwargs["domain"],
            "filename": kwargs["filename"],
            "content_hash": kwargs["content_hash"],
            "bytes": kwargs["size"],
            "mime": kwargs["mime"],
            "status": "pending",
            "last_error": None,
        }

    async def fake_parse_file(**kwargs):
        assert kwargs["file_id"] == "file-1"
        return [_el("Paper title", 1), _el("Therapeutic result and trial design", 2)]

    async def fake_infer_schema(*, domain_hint: str, samples: list[str]) -> DomainSchema:
        assert domain_hint == "research-papers"
        assert samples
        return DomainSchema(
            domain=domain_hint,
            name="inferred",
            entities=[
                EntityType(
                    name="Paper",
                    fields=[
                        FieldSpec(
                            name="title",
                            type="string",
                            description="Paper title",
                            identity=True,
                        )
                    ],
                )
            ],
        )

    monkeypatch.setattr(infer_route, "put_raw_file", fake_put_raw_file)
    monkeypatch.setattr(infer_route.repo, "upsert_domain", fake_upsert_domain)
    monkeypatch.setattr(infer_route.repo, "register_file", fake_register_file)
    monkeypatch.setattr(infer_route, "parse_file", fake_parse_file)
    monkeypatch.setattr(infer_route, "infer_schema", fake_infer_schema)

    out = await infer_route.infer_from_files(
        domain="research-papers",
        project="personal",
        sample_count=2,
        stage_files=True,
        files=[FakeUpload()],  # type: ignore[list-item]
    )

    assert out["project"] == "personal"
    assert out["domain"] == "research-papers"
    assert out["sample_count"] == 1
    assert out["staged_files"][0]["id"] == "file-1"
    assert out["errors"] == []
    assert calls == [("personal", "research-papers")]
