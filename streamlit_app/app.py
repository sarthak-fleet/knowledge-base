"""Project-aware private document search UI.

Two screens:

  1. Landing — list projects, create a new one.
  2. Workspace (after selecting a project) — search/chat with the corpus,
     add sources, and expose cited evidence for agents.

Backed by the standard REST API on the kb-api container.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import streamlit as st
import yaml
from streamlit_app.style import inject_css

API = os.environ.get("KB_API_URL", "http://api:8000")
HTTP = httpx.Client(timeout=180)


def _json_safe(o: Any) -> str:
    try:
        return json.dumps(o, indent=2, default=str)
    except Exception:
        return repr(o)


def api_get(path: str, **params: Any) -> Any:
    r = HTTP.get(f"{API}{path}", params={k: v for k, v in params.items() if v is not None})
    r.raise_for_status()
    return r.json()


def api_post(path: str, **payload: Any) -> Any:
    r = HTTP.post(f"{API}{path}", json=payload)
    r.raise_for_status()
    return r.json()


def api_delete(path: str, **params: Any) -> Any:
    r = HTTP.delete(f"{API}{path}", params={k: v for k, v in params.items() if v is not None})
    r.raise_for_status()
    return r.json()


def _parse_mapping(raw: str) -> dict[str, Any]:
    parsed = yaml.safe_load(raw)
    if not isinstance(parsed, dict):
        raise ValueError("expected a JSON/YAML object")
    return parsed


st.set_page_config(
    page_title="Agent Search for Private Docs",
    layout="wide",
    initial_sidebar_state="expanded",
)
inject_css()

# ── Session state ────────────────────────────────────────────────────────────
if "selected_project" not in st.session_state:
    st.session_state["selected_project"] = None
if "chat_history" not in st.session_state:
    st.session_state["chat_history"] = {}  # project → list[{role, content, citations?, conf?}]
if "session_ids" not in st.session_state:
    st.session_state["session_ids"] = {}  # project → session_id


def _enter_project(name: str) -> None:
    st.session_state["selected_project"] = name
    st.session_state["chat_history"].setdefault(name, [])
    st.rerun()


def _leave_project() -> None:
    st.session_state["selected_project"] = None
    st.rerun()


# ═══════════════════════════════════════════════════════════════════════════
# LANDING — list of projects
# ═══════════════════════════════════════════════════════════════════════════
if st.session_state["selected_project"] is None:
    st.markdown("## Agent Search for Private Docs")
    st.caption(f"API → {API}")
    st.markdown("---")

    projects = []
    try:
        projects = api_get("/projects")
    except Exception as e:
        st.error(f"Could not load projects: {e}")

    # Project cards in a grid
    if projects:
        st.markdown("### Your projects")
        cols = st.columns(3)
        for i, p in enumerate(projects):
            with cols[i % 3], st.container(border=True):
                st.markdown(f"#### {p['name']}")
                desc = (p.get("description") or "").strip()
                if desc:
                    st.caption(desc[:120])
                meta = f"{p.get('kind_count', 0)} kind(s)  ·  {p.get('file_count', 0)} file(s)"
                st.caption(meta)
                if st.button("Open →", key=f"open_{p['name']}", use_container_width=True):
                    _enter_project(p["name"])
    else:
        st.info("No projects yet. Create one below.")

    st.markdown("---")
    st.markdown("### Create a new project")
    with st.form("new_project_form", clear_on_submit=True):
        name = st.text_input(
            "Project name",
            placeholder="e.g. biotech-ipo",
            help="Lowercase, hyphens, no spaces. Used as a namespace key.",
        )
        description = st.text_area(
            "Description (optional)",
            placeholder="One sentence on what this project covers.",
            height=80,
        )
        submit = st.form_submit_button("Create project", type="primary")
    if submit:
        clean = (name or "").strip().lower().replace(" ", "-")
        if not clean:
            st.error("Project name is required.")
        else:
            try:
                api_post("/projects", name=clean, description=description.strip())
                st.success(f"Created project '{clean}'. Click below to open it.")
                _enter_project(clean)
            except Exception as e:
                st.error(f"Could not create project: {e}")

# ═══════════════════════════════════════════════════════════════════════════
# WORKSPACE — chat / files / schema for a single project
# ═══════════════════════════════════════════════════════════════════════════
else:
    project = st.session_state["selected_project"]

    # Sidebar
    st.sidebar.markdown(f"### {project}")
    if st.sidebar.button("← All projects", use_container_width=True):
        _leave_project()
    st.sidebar.markdown("---")

    # Pull schemas + files for this project
    schemas: list[dict] = []
    files: list[dict] = []
    corpus_status: list[dict] = []
    schema_drafts: list[dict] = []
    try:
        schemas = api_get("/schemas", project=project)
    except Exception as e:
        st.sidebar.warning(f"schemas: {e}")
    try:
        files = api_get("/files", project=project)
    except Exception as e:
        st.sidebar.warning(f"files: {e}")
    try:
        corpus_status = api_get(f"/projects/{project}/status")
    except Exception as e:
        st.sidebar.warning(f"status: {e}")
    try:
        schema_drafts = api_get("/schemas/drafts", project=project, status="pending")
    except Exception as e:
        st.sidebar.warning(f"drafts: {e}")

    available_kinds = sorted({s["domain"] for s in schemas})

    st.sidebar.caption(f"{len(available_kinds)} kind(s)  ·  {len(files)} file(s)  ·  API → {API}")
    if corpus_status:
        st.sidebar.markdown("#### Corpus status")
        for row in corpus_status[:12]:
            st.sidebar.caption(
                f"{row['domain']}: {row['state']} · "
                f"{row.get('ready_files', 0)}/{row.get('file_count', 0)} ready"
            )

    # Top bar
    st.markdown(f"## {project}")
    st.caption(
        "Turn specialized document sets into cited search and answer APIs for agents."
    )
    if corpus_status:
        st.dataframe(
            [
                {
                    "kind": r["domain"],
                    "state": r["state"],
                    "schema": "yes" if r.get("has_schema") else "no",
                    "drafts": r.get("draft_count", 0),
                    "files": r.get("file_count", 0),
                    "ready": r.get("ready_files", 0),
                    "active": r.get("active_jobs", 0) + r.get("active_files", 0),
                    "failed": r.get("failed_jobs", 0) + r.get("failed_files", 0),
                }
                for r in corpus_status
            ],
            use_container_width=True,
            hide_index=True,
        )

    tab_search, tab_chat, tab_onboard, tab_files, tab_data, tab_schemas, tab_eval = st.tabs(
        ["Agent Search", "Chat", "Onboard Kind", "Files", "Add Data", "Schemas", "Eval"]
    )

    # ── Agent Search tab ────────────────────────────────────────────────────
    with tab_search:
        st.markdown("### Cited search API")
        if not available_kinds:
            st.info("Add a schema and ingest data before searching.")
        else:
            search_cols = st.columns([3, 2, 1])
            with search_cols[0]:
                search_query = st.text_input("Search query", placeholder="Find evidence for...")
            with search_cols[1]:
                search_kinds = st.multiselect(
                    "Kinds",
                    options=available_kinds,
                    default=available_kinds,
                    key="agent_search_kinds",
                )
            with search_cols[2]:
                search_top_k = st.number_input("Top K", min_value=1, max_value=25, value=8)
            if st.button("Search", type="primary", use_container_width=True):
                try:
                    primary_kind = (search_kinds or available_kinds)[0]
                    out = api_post(
                        "/search",
                        project=project,
                        domain=primary_kind,
                        kinds=search_kinds or available_kinds,
                        query=search_query,
                        top_k=int(search_top_k),
                    )
                    for r in out.get("results", []):
                        with st.container(border=True):
                            st.markdown(
                                f"**#{r['rank']} · {r.get('filename', 'unknown')}** "
                                f"· {r.get('kind', '?')} · p. {r.get('page_start', 0)}"
                            )
                            st.caption(f"score {float(r.get('score', 0)):.3f}")
                            if r.get("highlights"):
                                st.caption("matched: " + ", ".join(r["highlights"]))
                            if r.get("context_before"):
                                st.caption("..." + r["context_before"])
                            st.write(r.get("excerpt", ""))
                            if r.get("context_after"):
                                st.caption(r["context_after"] + "...")
                except Exception as e:
                    st.error(f"Search failed: {e}")

    # ── Chat tab ─────────────────────────────────────────────────────────────
    with tab_chat:
        if not available_kinds:
            st.info(
                "This project has no schemas yet. Add a schema (in the Schemas tab) and upload "
                "a file or two before you can chat."
            )
        else:
            # Kind selector — default to all
            cols = st.columns([3, 2])
            with cols[0]:
                selected_kinds = st.multiselect(
                    "Search across kinds",
                    options=available_kinds,
                    default=available_kinds,
                    help="Each kind is its own schema + source-type. Pick one or many.",
                )
            with cols[1]:
                if st.button("Clear chat", use_container_width=True):
                    st.session_state["chat_history"][project] = []
                    st.session_state["session_ids"][project] = None
                    st.rerun()

            # Show conversation
            for turn in st.session_state["chat_history"].get(project, []):
                with st.chat_message(turn["role"]):
                    st.markdown(turn["content"])
                    if turn.get("citations"):
                        with st.expander(f"{len(turn['citations'])} citation(s)"):
                            for c in turn["citations"]:
                                excerpt = (c.get("excerpt") or "")[:200]
                                st.markdown(
                                    f"- **{c.get('filename', '?')}** "
                                    f"(p. {c.get('page_start', '?')})  · _{excerpt}_"
                                )
                    if turn.get("confidence"):
                        cf = turn["confidence"]
                        st.caption(
                            f"Confidence: {cf.get('value', 0):.2f}  · {cf.get('reason', '')}"
                        )

            # Chat input
            if question := st.chat_input("Ask the corpus..."):
                history = st.session_state["chat_history"].setdefault(project, [])
                history.append({"role": "user", "content": question})

                # The /query API still needs a primary `domain`; use the first selected kind.
                primary_kind = selected_kinds[0] if selected_kinds else available_kinds[0]
                kinds_for_query = selected_kinds or available_kinds

                with st.spinner(f"retrieving across {len(kinds_for_query)} kind(s)..."):
                    try:
                        result = api_post(
                            "/query",
                            project=project,
                            domain=primary_kind,
                            kinds=kinds_for_query,
                            question=question,
                            session_id=st.session_state["session_ids"].get(project),
                        )
                        st.session_state["session_ids"][project] = result.get("session_id")
                        history.append(
                            {
                                "role": "assistant",
                                "content": result.get("answer", "(no answer)"),
                                "citations": result.get("citations", []),
                                "confidence": result.get("confidence"),
                            }
                        )
                    except Exception as e:
                        history.append({"role": "assistant", "content": f"_Query failed: {e}_"})
                st.rerun()

    # ── Onboard Kind tab ────────────────────────────────────────────────────
    with tab_onboard:
        st.markdown("### Infer and confirm a new kind")
        with st.form("infer_kind_form"):
            infer_kind = st.text_input(
                "Kind key",
                placeholder="e.g. research-papers, company-info, contracts",
            )
            sample_files = st.file_uploader(
                "Representative files",
                accept_multiple_files=True,
                help="Use a few PDFs, spreadsheets, notes, or internal docs to infer the schema before ingestion.",
            )
            sample_text = st.text_area(
                "Or paste sample text",
                height=220,
                placeholder="Paste representative data. Separate multiple samples with a line containing ---.",
            )
            stage_sample_files = st.checkbox(
                "Stage uploaded files for ingestion after schema confirmation",
                value=True,
                disabled=not sample_files,
            )
            infer_submit = st.form_submit_button("Infer schema", type="primary")
        if infer_submit:
            try:
                clean_kind = (infer_kind or "").strip().lower().replace(" ", "-")
                if not clean_kind:
                    raise ValueError("kind key is required")
                if not sample_files and not sample_text.strip():
                    raise ValueError("upload representative files or paste sample text")
                if sample_files:
                    multipart = [
                        (
                            "files",
                            (
                                f.name,
                                f.getvalue(),
                                f.type or "application/octet-stream",
                            ),
                        )
                        for f in sample_files
                    ]
                    r = HTTP.post(
                        f"{API}/schemas/infer/files",
                        data={
                            "project": project,
                            "domain": clean_kind,
                            "stage_files": str(bool(stage_sample_files)).lower(),
                        },
                        files=multipart,
                    )
                    r.raise_for_status()
                    out = r.json()
                else:
                    samples = [
                        s.strip()
                        for s in sample_text.split("\n---\n")
                        if s.strip()
                    ] or [sample_text.strip()]
                    out = api_post(
                        "/schemas/infer",
                        project=project,
                        domain=clean_kind,
                        sample_texts=samples,
                    )
                st.success(
                    f"Inferred schema for {clean_kind}. Draft {out.get('draft_id') or ''} is ready below."
                )
                if out.get("staged_files"):
                    st.info(f"Staged {len(out['staged_files'])} file(s) for later ingestion.")
                if out.get("errors"):
                    st.warning(_json_safe(out["errors"]))
                st.rerun()
            except Exception as e:
                st.error(f"Could not infer schema: {e}")

        if schema_drafts:
            draft_labels = {
                f"{d['domain']} · {d['source']} · {d['id'][:8]}": d for d in schema_drafts
            }
            selected_label = st.selectbox("Pending schema draft", options=list(draft_labels))
            pending_draft = draft_labels[selected_label]
            pending_spec = pending_draft["spec"]
            staged_file_ids = pending_draft.get("staged_file_ids", [])
            st.caption(
                f"{pending_draft.get('sample_count', 0)} sample(s)"
                f" · {len(staged_file_ids)} staged file(s)"
            )
            if pending_draft.get("errors"):
                with st.expander("Parse errors"):
                    st.json(pending_draft["errors"])
            edited_schema = st.text_area(
                "Confirmed schema JSON/YAML",
                height=340,
                value=yaml.safe_dump(pending_spec, sort_keys=False),
                key=f"schema_editor_{pending_draft['id']}",
            )
            ingest_after_apply = st.checkbox(
                "Ingest staged files after applying",
                value=bool(staged_file_ids),
                disabled=not staged_file_ids,
            )
            cols = st.columns([2, 1])
            if cols[0].button("Apply confirmed schema", type="primary", use_container_width=True):
                try:
                    spec = _parse_mapping(edited_schema)
                    out = api_post(
                        f"/schemas/drafts/{pending_draft['id']}/apply",
                        project=project,
                        spec=spec,
                        ingest_staged_files=ingest_after_apply,
                    )
                    st.success(
                        f"Applied {out['project']}/{out['domain']} schema v{out['version']}; "
                        f"enqueued {out.get('enqueued', 0)} file(s)."
                    )
                    st.rerun()
                except Exception as e:
                    st.error(f"Could not apply schema: {e}")
            if cols[1].button("Discard draft", use_container_width=True):
                try:
                    api_post(f"/schemas/drafts/{pending_draft['id']}/discard", project=project)
                    st.success("Discarded draft.")
                    st.rerun()
                except Exception as e:
                    st.error(f"Could not discard draft: {e}")
        else:
            st.info("No pending schema drafts.")

    # ── Files tab ────────────────────────────────────────────────────────────
    with tab_files:
        st.markdown("### Files in this project")
        if not files:
            st.info("No files yet.")
        else:
            st.dataframe(
                [
                    {
                        "id": f["id"][:8],
                        "kind": f.get("domain", "?"),
                        "filename": f["filename"],
                        "bytes": f["bytes"],
                        "status": f["status"],
                        "error": (f.get("last_error") or "")[:60],
                    }
                    for f in files
                ],
                use_container_width=True,
                height=320,
            )
            file_labels = {
                f"{f['filename']}  ·  {f.get('domain', '?')}  ·  {f['id'][:8]}": f for f in files
            }
            selected_file_label = st.selectbox("Manage file", options=list(file_labels))
            selected_file = file_labels[selected_file_label]
            cols = st.columns([1, 1, 2])
            if cols[0].button("Reprocess", use_container_width=True):
                try:
                    r = HTTP.post(
                        f"{API}/files/{selected_file['id']}/reprocess",
                        params={"project": project},
                    )
                    r.raise_for_status()
                    st.success(f"Queued job {r.json()['job_id'][:8]}.")
                    st.rerun()
                except Exception as e:
                    st.error(f"Could not reprocess file: {e}")
            confirm_delete = cols[1].checkbox("Confirm delete")
            if cols[2].button("Delete file", use_container_width=True, disabled=not confirm_delete):
                try:
                    api_delete(f"/files/{selected_file['id']}", project=project)
                    st.success("Deleted file and indexed chunks.")
                    st.rerun()
                except Exception as e:
                    st.error(f"Could not delete file: {e}")

        st.markdown("---")
        st.markdown("### Add files")
        if not available_kinds:
            st.info("Add a schema first (Schemas tab) so the file has a kind to land under.")
        else:
            with st.form("upload_form", clear_on_submit=True):
                target_kind = st.selectbox(
                    "Kind", options=available_kinds, help="Which schema should process these files."
                )
                uploaded = st.file_uploader(
                    "Drop files (PDF, HTML, XLSX, TXT, DOCX, ...)",
                    accept_multiple_files=True,
                )
                cols = st.columns([1, 1, 4])
                kick = cols[0].checkbox("Auto-ingest", value=True)
                force = cols[1].checkbox("Force re-ingest", value=False)
                submit = st.form_submit_button("Upload", type="primary")
            if submit and uploaded:
                ok = 0
                for f in uploaded:
                    try:
                        r = HTTP.post(
                            f"{API}/files",
                            data={"project": project, "domain": target_kind},
                            files={
                                "file": (
                                    f.name,
                                    f.getvalue(),
                                    f.type or "application/octet-stream",
                                )
                            },
                        )
                        r.raise_for_status()
                        ok += 1
                    except Exception as e:
                        st.error(f"{f.name}: {e}")
                st.success(
                    f"Uploaded {ok}/{len(uploaded)} file(s) → project '{project}' / kind '{target_kind}'."
                )
                if kick:
                    try:
                        rr = HTTP.post(
                            f"{API}/ingest/run",
                            json={"project": project, "domain": target_kind, "force": force},
                        )
                        rr.raise_for_status()
                        st.info(
                            f"Enqueued {rr.json().get('enqueued', 0)} job(s); "
                            "tail `docker compose logs -f worker` to watch."
                        )
                    except Exception as e:
                        st.warning(f"Auto-ingest skipped: {e}")
                st.rerun()

        st.markdown("---")
        st.markdown("### Optional imports from demo sources")
        st.caption(
            "Manual files and records are the first-class path. These adapters are convenience demos."
        )
        try:
            source_names = api_get("/sources").get("sources", [])
        except Exception as e:
            source_names = []
            st.warning(f"sources: {e}")
        if not available_kinds:
            st.info("Add a schema first so imported documents have a kind.")
        elif source_names:
            with st.form("source_import_form"):
                import_kind = st.selectbox("Kind", options=available_kinds, key="import_kind")
                source_name = st.selectbox("Source", options=source_names)
                urls_text = ""
                tickers_text = ""
                forms_text = "10-K,10-Q,8-K"
                days = 540
                limit_total = 12
                if source_name == "url":
                    urls_text = st.text_area("URLs", height=140)
                elif source_name == "edgar":
                    tickers_text = st.text_input("Tickers", value="AAPL,MSFT,NVDA")
                    forms_text = st.text_input("Forms", value=forms_text)
                    days = st.number_input("Lookback days", min_value=1, value=days)
                    limit_total = st.number_input("Total filing limit", min_value=1, value=limit_total)
                auto_import = st.checkbox("Auto-ingest imported files", value=True)
                import_submit = st.form_submit_button("Import", type="primary")
            if import_submit:
                try:
                    if source_name == "url":
                        cfg = {"urls": [u.strip() for u in urls_text.splitlines() if u.strip()]}
                    elif source_name == "edgar":
                        cfg = {
                            "tickers": [t.strip().upper() for t in tickers_text.split(",") if t.strip()],
                            "forms": [f.strip() for f in forms_text.split(",") if f.strip()],
                            "days": int(days),
                            "limit_total": int(limit_total),
                        }
                    else:
                        cfg = {}
                    out = api_post(
                        "/sources/import",
                        project=project,
                        domain=import_kind,
                        source=source_name,
                        config=cfg,
                        auto_ingest=auto_import,
                    )
                    st.success(
                        f"Imported {out['file_count']} file(s); enqueued {out['enqueued']} job(s)."
                    )
                    if out.get("errors"):
                        st.warning(_json_safe(out["errors"]))
                    st.rerun()
                except Exception as e:
                    st.error(f"Could not import source: {e}")

        st.markdown("---")
        st.markdown("### Ingest jobs")
        try:
            jobs = api_get("/ingest/jobs", project=project)
        except Exception as e:
            jobs = []
            st.warning(f"jobs: {e}")
        if jobs:
            st.dataframe(
                [
                    {
                        "id": j["id"][:8],
                        "kind": j.get("domain", "?"),
                        "stage": j["stage"],
                        "status": j["status"],
                        "attempts": j["attempts"],
                        "error": (j.get("last_error") or "")[:60],
                    }
                    for j in jobs[:50]
                ],
                use_container_width=True,
                height=240,
            )

    # ── Add Data tab ─────────────────────────────────────────────────────────
    with tab_data:
        st.markdown("### Add text")
        if not available_kinds:
            st.info("Add a schema first so text can be extracted into typed entities.")
        else:
            with st.form("text_ingest_form", clear_on_submit=True):
                text_kind = st.selectbox("Kind", options=available_kinds, key="text_kind")
                text_title = st.text_input("Title", value="note")
                text_body = st.text_area("Text", height=220)
                submit_text = st.form_submit_button("Ingest text", type="primary")
            if submit_text:
                try:
                    out = api_post(
                        "/ingest/text",
                        project=project,
                        kind=text_kind,
                        title=text_title,
                        text=text_body,
                    )
                    st.success(
                        f"Queued text file {out['file_id'][:8]} "
                        f"as job {(out.get('job_id') or '')[:8]}."
                    )
                    st.rerun()
                except Exception as e:
                    st.error(f"Could not ingest text: {e}")

        st.markdown("---")
        st.markdown("### Add structured records")
        if not available_kinds:
            st.info("Add a schema first so records can be validated.")
        else:
            record_kind = st.selectbox("Kind", options=available_kinds, key="record_kind")
            entity_types: list[str] = []
            try:
                full_schema = api_get(f"/schemas/{record_kind}/active", project=project)
                entity_types = [e["name"] for e in full_schema["spec"].get("entities", [])]
            except Exception as e:
                st.warning(f"Could not load entity types: {e}")
            if entity_types:
                with st.form("record_ingest_form", clear_on_submit=True):
                    record_type = st.selectbox("Entity type", options=entity_types)
                    record_json = st.text_area(
                        "Record JSON/YAML",
                        height=220,
                        value='{"name": "Example", "description": "Replace this with a real record"}',
                    )
                    submit_record = st.form_submit_button("Ingest record", type="primary")
                if submit_record:
                    try:
                        data = yaml.safe_load(record_json)
                        if not isinstance(data, (dict, list)):
                            raise ValueError("record payload must be an object or list of objects")
                        out = api_post(
                            "/ingest/record",
                            project=project,
                            kind=record_kind,
                            type=record_type,
                            data=data,
                        )
                        st.success(
                            f"Stored {out['entities_upserted']} entities and indexed "
                            f"{out.get('chunks_indexed', 0)} chunks."
                        )
                        st.rerun()
                    except Exception as e:
                        st.error(f"Could not ingest record: {e}")
            else:
                st.info("The selected schema has no entity types.")

    # ── Schemas tab ──────────────────────────────────────────────────────────
    with tab_schemas:
        st.markdown("### Schemas in this project")
        if not schemas:
            st.info(
                "No schemas yet. Use the CLI from the host to apply one:  "
                f"`kb schema apply --project {project} domains/<kind>/schema.yaml`"
            )
        else:
            for s in schemas:
                with st.expander(f"{s['domain']}  ·  v{s['version']}  ({s['entity_count']} types)"):
                    try:
                        full = api_get(f"/schemas/{s['domain']}/active", project=project)
                        spec = full["spec"]
                        st.markdown(f"**Name**: {spec.get('name', '?')}")
                        st.markdown(
                            f"**Description**: {(spec.get('description') or '').strip() or '_none_'}"
                        )
                        for et in spec.get("entities", []):
                            st.markdown(f"- **{et['name']}** — {et.get('description', '')[:140]}")
                            field_names = ", ".join(f["name"] for f in et.get("fields", []))
                            st.caption(field_names)
                        if st.button(
                            "Reprocess files for this schema",
                            key=f"schema_reprocess_{s['domain']}",
                        ):
                            rr = api_post(f"/schemas/{s['domain']}/reprocess", project=project)
                            st.success(f"Enqueued {rr['enqueued']} file(s) for extraction.")
                    except Exception as e:
                        st.warning(f"Could not fetch schema detail: {e}")

        st.markdown("---")
        st.markdown("### Apply schema")
        with st.form("schema_apply_form", clear_on_submit=True):
            schema_text = st.text_area(
                "Schema JSON/YAML",
                height=320,
                placeholder="Paste a schema with domain, name, entities, and relationships.",
            )
            submit_schema = st.form_submit_button("Apply schema", type="primary")
        if submit_schema:
            try:
                spec = _parse_mapping(schema_text)
                domain = str(spec.get("domain") or "").strip()
                name = str(spec.get("name") or "default").strip()
                if not domain:
                    raise ValueError("schema must include domain")
                out = api_post(
                    "/schemas",
                    project=project,
                    domain=domain,
                    name=name,
                    spec=spec,
                )
                st.success(f"Applied {out['project']}/{out['domain']} schema v{out['version']}.")
                st.rerun()
            except Exception as e:
                st.error(f"Could not apply schema: {e}")

    # ── Eval tab ─────────────────────────────────────────────────────────────
    with tab_eval:
        st.markdown("### Quick project eval")
        if not available_kinds:
            st.info("Add a schema and ingest data before running evals.")
        else:
            eval_kind = st.selectbox("Primary kind", options=available_kinds, key="eval_kind")
            eval_kinds = st.multiselect(
                "Search kinds",
                options=available_kinds,
                default=[eval_kind],
                key="eval_kinds",
            )
            eval_yaml = st.text_area(
                "Questions YAML",
                height=260,
                value="questions:\n  - id: q1\n    question: \"What is the most important fact in this project?\"\n    expected_files: []\n    key_facts: []\n",
            )
            eval_top_k = st.number_input("Eval Top K", min_value=1, max_value=25, value=8)
            run_answer_eval = st.checkbox("Also run answer synthesis eval", value=False)
            if st.button("Run eval", type="primary"):
                try:
                    ds = _parse_mapping(eval_yaml)
                    qs = ds.get("questions") or []
                    if not isinstance(qs, list) or not qs:
                        raise ValueError("questions must be a non-empty list")
                    search_questions = [
                        {
                            "id": str(item.get("id", f"q{i + 1}")),
                            "query": str(item.get("query") or item.get("question") or ""),
                            "expected_files": item.get("expected_files", []),
                            "key_facts": item.get("key_facts", []),
                        }
                        for i, item in enumerate(qs)
                    ]
                    search_eval = api_post(
                        "/search/eval",
                        project=project,
                        domain=eval_kind,
                        kinds=eval_kinds or [eval_kind],
                        top_k=int(eval_top_k),
                        questions=search_questions,
                    )
                    metric_cols = st.columns(4)
                    metric_cols[0].metric("Recall", f"{search_eval['mean_recall']:.2f}")
                    metric_cols[1].metric("MRR", f"{search_eval['mean_mrr']:.2f}")
                    metric_cols[2].metric("Precision", f"{search_eval['mean_precision']:.2f}")
                    metric_cols[3].metric("p95 ms", f"{search_eval['p95_latency_ms']:.0f}")
                    st.dataframe(search_eval["rows"], use_container_width=True)

                    if run_answer_eval:
                        rows = []
                        for item in qs:
                            result = api_post(
                                "/query",
                                project=project,
                                domain=eval_kind,
                                kinds=eval_kinds or [eval_kind],
                                question=str(item.get("question") or item.get("query") or ""),
                            )
                            expected = [str(x).lower() for x in item.get("expected_files", [])]
                            cited = [
                                str(c.get("filename", "")).lower()
                                for c in result.get("citations", [])
                            ]
                            file_hit = (
                                None
                                if not expected
                                else any(any(e in c or c in e for c in cited) for e in expected)
                            )
                            rows.append(
                                {
                                    "id": item.get("id", ""),
                                    "citations": len(result.get("citations", [])),
                                    "expected_file_hit": file_hit,
                                    "confidence": (result.get("confidence") or {}).get("value", 0),
                                    "answer": result.get("answer", "")[:220],
                                }
                            )
                        st.markdown("#### Answer synthesis")
                        st.dataframe(rows, use_container_width=True)
                except Exception as e:
                    st.error(f"Eval failed: {e}")
