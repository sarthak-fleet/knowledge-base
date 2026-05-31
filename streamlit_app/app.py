"""Project-aware Knowledge Base demo UI.

Two screens:

  1. Landing — list projects, create a new one.
  2. Workspace (after selecting a project) — chat with the corpus, add files,
     pick which kinds (= source-types) to query against.

Backed by the standard REST API on the kb-api container.
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import streamlit as st
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


st.set_page_config(page_title="Knowledge Base", layout="wide", initial_sidebar_state="expanded")
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
    st.markdown("## Knowledge Base")
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
    try:
        schemas = api_get("/schemas", project=project)
    except Exception as e:
        st.sidebar.warning(f"schemas: {e}")
    try:
        files = api_get("/files", project=project)
    except Exception as e:
        st.sidebar.warning(f"files: {e}")

    available_kinds = sorted({s["domain"] for s in schemas})

    st.sidebar.caption(f"{len(available_kinds)} kind(s)  ·  {len(files)} file(s)  ·  API → {API}")

    # Top bar
    st.markdown(f"## {project}")
    st.caption("Add files, define schemas, chat with the corpus across one or many kinds.")

    tab_chat, tab_files, tab_schemas = st.tabs(["Chat", "Files", "Schemas"])

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
                    except Exception as e:
                        st.warning(f"Could not fetch schema detail: {e}")
