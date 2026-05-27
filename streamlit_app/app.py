"""HighSignal-styled Streamlit demo.

Pages:
  - Overview: schema, files (with upload widget), ingest status
  - Query: ask a question; see cited answer + retrieved nodes + per-stage trace
  - Entities: browse + drill into lineage / relationships
  - Eval: read the latest eval report
"""

from __future__ import annotations

import json
import os
from typing import Any

import httpx
import streamlit as st

from streamlit_app.style import inject_css


def _json_safe(o: Any) -> str:
    try:
        return json.dumps(o, indent=2, default=str)
    except Exception:
        return repr(o)

API = os.environ.get("KB_API_URL", "http://api:8000")
HTTP = httpx.Client(timeout=180)


def api_get(path: str, **params: Any) -> Any:
    r = HTTP.get(f"{API}{path}", params=params)
    r.raise_for_status()
    return r.json()


def api_post(path: str, **payload: Any) -> Any:
    r = HTTP.post(f"{API}{path}", json=payload)
    r.raise_for_status()
    return r.json()


st.set_page_config(page_title="Knowledge Base", layout="wide", initial_sidebar_state="expanded")
inject_css()

st.sidebar.markdown("### KB")
domain = st.sidebar.selectbox("Domain", options=[d["name"] for d in api_get("/domains")] or ["sec"], index=0)
page = st.sidebar.radio("View", ["Overview", "Query", "Entities", "Eval"], label_visibility="collapsed")

st.sidebar.markdown("---")
st.sidebar.caption(f"API → {API}")

# ── Overview ───────────────────────────────────────────────────────────────
if page == "Overview":
    st.markdown("#### Schema")
    sch = None
    try:
        sch = api_get(f"/schemas/{domain}/active")
    except Exception:
        st.warning("No active schema for this domain.")
    if sch:
        spec = sch["spec"]
        st.caption(f"{spec['name']}  ·  v{sch['version']}")
        cols = st.columns(3)
        for i, et in enumerate(spec["entities"]):
            with cols[i % 3]:
                st.markdown(f"**{et['name']}** — {et.get('description','')[:120]}")
                st.caption(", ".join(f["name"] for f in et["fields"]))

    st.markdown("#### Upload")
    with st.form("upload_form", clear_on_submit=True):
        uploaded = st.file_uploader(
            "Drop one or more files (PDF, HTML, XLSX, TXT, DOCX, …)",
            accept_multiple_files=True,
        )
        col_a, col_b = st.columns([1, 5])
        kick = col_a.checkbox("Auto-ingest after upload", value=True)
        force = col_b.checkbox("Force re-ingest if file already exists", value=False)
        submit = st.form_submit_button("Upload", type="primary")
    if submit and uploaded:
        ok = 0
        for f in uploaded:
            try:
                r = HTTP.post(
                    f"{API}/files",
                    data={"domain": domain},
                    files={"file": (f.name, f.getvalue(), f.type or "application/octet-stream")},
                )
                r.raise_for_status()
                ok += 1
            except Exception as e:
                st.error(f"{f.name}: {e}")
        st.success(f"Uploaded {ok}/{len(uploaded)} file(s) into domain '{domain}'.")
        if kick:
            try:
                rr = HTTP.post(f"{API}/ingest/run", json={"domain": domain, "force": force})
                rr.raise_for_status()
                st.info(f"Enqueued {rr.json().get('enqueued', 0)} jobs; tail `docker compose logs -f worker` to watch.")
            except Exception as e:
                st.warning(f"Auto-ingest skipped: {e}")
        st.rerun()

    st.markdown("#### Files")
    files = api_get("/files", domain=domain)
    if not files:
        st.info("No files yet. Run `make seed` from the host to populate the SEC demo.")
    else:
        st.dataframe(
            [
                {
                    "id": f["id"][:8],
                    "filename": f["filename"],
                    "bytes": f["bytes"],
                    "status": f["status"],
                    "error": (f.get("last_error") or "")[:80],
                }
                for f in files
            ],
            use_container_width=True,
            height=320,
        )

    st.markdown("#### Jobs")
    jobs = api_get("/ingest/jobs", domain=domain)
    if jobs:
        st.dataframe(
            [
                {"id": j["id"][:8], "stage": j["stage"], "status": j["status"], "attempts": j["attempts"], "error": (j.get("last_error") or "")[:60]}
                for j in jobs[:50]
            ],
            use_container_width=True,
            height=240,
        )

# ── Query ──────────────────────────────────────────────────────────────────
elif page == "Query":
    st.markdown("#### Ask the corpus")
    question = st.text_area("Question", placeholder="e.g. What does NVIDIA say about export controls in their most recent 10-K?", height=80)
    cols = st.columns([1, 1, 1, 6])
    submit = cols[0].button("Ask", type="primary")
    scope_entity = cols[1].text_input("scope:entity_id", "")
    scope_file = cols[2].text_input("scope:file_id", "")
    if "session_id" not in st.session_state:
        st.session_state["session_id"] = None

    if submit and question.strip():
        scope: dict[str, Any] = {}
        if scope_entity:
            scope["entity_id"] = scope_entity
        if scope_file:
            scope["file_id"] = scope_file
        with st.spinner("retrieving + synthesizing..."):
            res = api_post(
                "/query",
                domain=domain,
                question=question,
                session_id=st.session_state["session_id"],
                scope=scope or None,
            )
        st.session_state["session_id"] = res.get("session_id")

        st.markdown("##### Answer")
        st.write(res["answer"])
        c = res.get("confidence") or {}
        st.caption(f"confidence: {c.get('value', 0):.2f} — {c.get('reason','')}")

        st.markdown("##### Citations")
        for i, cit in enumerate(res.get("citations") or [], start=1):
            with st.container(border=True):
                page_str = (
                    f"{cit['page_start']}-{cit['page_end']}"
                    if cit['page_end'] != cit['page_start']
                    else str(cit['page_start'])
                )
                st.markdown(f"**[{i}]** `{cit['filename']}` — page {page_str}")
                st.caption(cit["excerpt"])
                also = cit.get("also_in") or []
                if also:
                    st.markdown(
                        "Same text also appears in: "
                        + ", ".join(f"`{a['filename']}`" for a in also)
                    )
                # Provenance viewer: surface the raw source with the cited excerpt highlighted.
                with st.expander("View in source"):
                    try:
                        files = api_get("/files", domain=domain)
                        f = next((ff for ff in files if ff["id"] == cit["file_id"]), None)
                        if f:
                            st.caption(f"file_id={cit['file_id']} · {f.get('bytes', 0)} bytes · {f.get('mime') or '—'}")
                            # No download endpoint yet; show the cited excerpt with surrounding chunk text.
                            for n in res.get("retrieved") or []:
                                if n.get("file_id") == cit["file_id"]:
                                    ex = n.get("excerpt", "")
                                    cited = cit["excerpt"][:120].strip()
                                    if cited and cited in ex:
                                        before, _, after = ex.partition(cited)
                                        st.markdown(
                                            f"…{before[-200:]}**:violet[{cited}]**{after[:200]}…"
                                        )
                                        break
                                    st.markdown(f"…{ex[:400]}…")
                                    break
                    except Exception as e:
                        st.caption(f"provenance unavailable: {e}")

        with st.expander(f"Retrieved nodes ({len(res.get('retrieved') or [])})"):
            for n in res.get("retrieved") or []:
                st.markdown(f"- `{n['node_id'][:8]}` score={n['score']:.3f} file={n.get('file_id','?')[:8]} — {n['excerpt']}")

        if res.get("trace_id"):
            try:
                trace = api_get(f"/query/trace/{res['trace_id']}")
                stages = (trace.get("filters") or {}).get("_stages") or []
                intent = (trace.get("filters") or {}).get("_intent") or {}
                tok = (trace.get("filters") or {}).get("_token_usage") or {}
                with st.expander("How did we answer this? (stage decomposition)"):
                    if stages:
                        n_cols = min(len(stages), 5)
                        cols = st.columns(n_cols)
                        for i, s in enumerate(stages):
                            cols[i % n_cols].metric(s["stage"], f"{s['latency_ms']} ms")
                    st.markdown(f"**Intent**: `{intent.get('kind','?')}` — {intent.get('reason','')}")
                    if intent.get("filters"):
                        st.code(_json_safe(intent["filters"]), language="json")
                    st.markdown(
                        f"**Tokens (synthesis)**: in={tok.get('prompt_tokens', 0)} "
                        f"out={tok.get('completion_tokens', 0)} total={tok.get('total_tokens', 0)}"
                    )
                    st.markdown(f"**Total latency**: {trace.get('latency_ms', 0)} ms")
                    st.caption(f"trace_id = `{res['trace_id']}`")
            except Exception as e:
                st.caption(f"trace_id={res.get('trace_id')} (visualization unavailable: {e})")

# ── Entities ───────────────────────────────────────────────────────────────
elif page == "Entities":
    spec: dict | None = None
    try:
        spec = api_get(f"/schemas/{domain}/active")["spec"]
    except Exception:
        st.warning("No active schema."); st.stop()
    types = [e["name"] for e in spec["entities"]]
    cols = st.columns([2, 5])
    etype = cols[0].selectbox("Type", types)
    q = cols[1].text_input("Search", "")
    rows = api_get("/entities", domain=domain, type=etype, q=q or None)
    st.dataframe(
        [
            {"id": r["id"][:8], "type": r["type"], "display_name": r.get("display_name"), "identity_key": r["identity_key"][:64]}
            for r in rows
        ],
        use_container_width=True,
        height=260,
    )
    if rows:
        eid = st.selectbox("Entity", [r["id"] for r in rows], format_func=lambda x: next((r["display_name"] or x for r in rows if r["id"] == x), x))
        if eid:
            lineage = api_get(f"/entities/{eid}/lineage")
            rels = api_get(f"/entities/{eid}/relationships")
            c1, c2, c3 = st.columns(3)
            with c1:
                st.markdown("**Ancestors**")
                for a in lineage["ancestors"]:
                    st.markdown(f"- `{a['type']}` {a.get('display_name','')}")
            with c2:
                st.markdown("**Children**")
                for c in lineage["children"][:30]:
                    st.markdown(f"- `{c['type']}` {c.get('display_name','')}")
            with c3:
                st.markdown("**Mentions**")
                for m in lineage["mentions"][:20]:
                    st.markdown(f"- `{m['filename']}` (conf {m['confidence']:.2f})")
            st.markdown("**Relationships**")
            for r in rels[:30]:
                st.markdown(f"- `{r['rel_type']}` {r.get('src_name','')} → {r.get('dst_name','')}")

# ── Eval ────────────────────────────────────────────────────────────────────
elif page == "Eval":
    st.markdown("#### Eval")
    st.caption("Trigger from the host with `make eval` (SEC) or `make eval-legal` (legal). Reports load from /app.")
    import pathlib
    reports = {
        "sec": pathlib.Path("/app/eval_report.json"),
        "legal": pathlib.Path("/app/eval_report_legal.json"),
    }
    available = [d for d, p in reports.items() if p.exists()]
    if not available:
        st.info("No eval reports yet — run `make eval` or `make eval-legal`.")
    else:
        which = st.selectbox("Report", available, index=0)
        import json as _json
        j = _json.loads(reports[which].read_text())
        cols = st.columns(4)
        cols[0].metric("Citation F1", f"{j['mean_citation_f1']:.3f}")
        cols[1].metric("Citation P", f"{j['mean_citation_precision']:.3f}")
        cols[2].metric("Citation R", f"{j['mean_citation_recall']:.3f}")
        cols[3].metric("Answer pass %", f"{j['answer_pass_rate']*100:.1f}")
        if j.get("per_tag"):
            st.markdown("**Per-category breakdown**")
            st.dataframe(
                [
                    {
                        "tag": t,
                        "n": v["n"],
                        "pass %": round(v["pass_rate"] * 100, 1),
                        "cit F1": round(v["mean_citation_f1"], 2),
                    }
                    for t, v in sorted(j["per_tag"].items(), key=lambda x: -x[1]["n"])
                ],
                use_container_width=True,
                height=200,
            )
        st.markdown("**Per-question results**")
        st.dataframe(
            [
                {
                    "qid": s["qid"],
                    "answer_pass": "✓" if s["answer_pass"] else "✗",
                    "cit_f1": round(s["citation_f1"], 2),
                    "conf": round(s["confidence"], 2),
                    "tags": ", ".join(s.get("tags", [])),
                    "judge_reason": s["judge_reason"][:80],
                }
                for s in j["scores"]
            ],
            use_container_width=True,
            height=400,
        )
