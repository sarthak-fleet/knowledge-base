"""Streamlit theming + CSS to match HighSignal's design language.

Reference: fleet/high-signal/apps/web/src/app/globals.css
"""

from __future__ import annotations

import streamlit as st


CSS = """
<style>
:root {
  --bg: #1a1a1a;
  --fg: #f4f4f4;
  --muted: #8a8a8a;
  --line: #2e2e2e;
  --accent: #3ec5d4;
  --up: #5fd49b;
  --down: #e87a5d;
}
html, body, [class*="css"]  {
  background-color: var(--bg) !important;
  color: var(--fg) !important;
  font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace !important;
  font-feature-settings: "ss01" on, "cv11" on;
}
.stApp { background-color: var(--bg); }
section[data-testid="stSidebar"] { background-color: #141414; border-right: 1px solid var(--line); }
.stMarkdown h1, .stMarkdown h2, .stMarkdown h3, .stMarkdown h4 { color: var(--fg); letter-spacing: 0.01em; }
.stMarkdown h4 { border-bottom: 1px solid var(--line); padding-bottom: 6px; }
[data-testid="stMetricValue"] { color: var(--accent); font-variant-numeric: tabular-nums; }
[data-testid="stMetricLabel"] { color: var(--muted); }
.stButton button {
  background: transparent;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 2px;
}
.stButton button:hover { background: var(--accent); color: #000; }
div[data-baseweb="input"] input, .stTextArea textarea {
  background: #111 !important; color: var(--fg) !important; border: 1px solid var(--line) !important;
}
[data-testid="stDataFrame"] { border: 1px solid var(--line); }
.block-container { padding-top: 1.5rem; }
.stCaption, .small { color: var(--muted) !important; }
hr { border-color: var(--line); }
::selection { background: var(--accent); color: #000; }
</style>
"""


def inject_css() -> None:
    st.markdown(CSS, unsafe_allow_html=True)
