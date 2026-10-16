#!/usr/bin/env python3
"""Capture dashboard page screenshots for docs/README illustrations.

Usage: python scripts/shoot-docs.py [--base http://localhost:7777] [--out docs/images/features]
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

from playwright.sync_api import sync_playwright

PAGES: list[tuple[str, str]] = [
    ("00-nav-overview", "/chat"),
    ("01-chat", "/chat"),
    ("04-live-sessions", "/live-sessions"),
    ("15-session-gallery", "/live-sessions/gallery"),
    ("16-session-graph", "/live-sessions/graph"),
    ("05-supervisor", "/supervisor"),
    ("06-tasks", "/tasks"),
    ("07-cost-time", "/insights"),
    ("08-system", "/system"),
    ("13-repos", "/repos"),
    ("09-extensions", "/extensions"),
    ("11-logs", "/logs"),
    ("12-jobs", "/jobs"),
    ("14-settings", "/settings"),
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base", default="http://localhost:7777")
    ap.add_argument("--out", default="docs/images/features")
    ap.add_argument("--width", type=int, default=1440)
    ap.add_argument("--height", type=int, default=900)
    ap.add_argument("--scale", type=float, default=2.0)
    ap.add_argument("--settle", type=float, default=2.5, help="seconds to wait after load")
    ap.add_argument("--only", default="", help="comma-separated names to capture")
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    only = {s.strip() for s in args.only.split(",") if s.strip()}

    with sync_playwright() as p:
        browser = p.chromium.launch()
        ctx = browser.new_context(
            viewport={"width": args.width, "height": args.height},
            device_scale_factor=args.scale,
            color_scheme="dark",
        )
        page = ctx.new_page()
        for name, path in PAGES:
            if only and name not in only:
                continue
            url = args.base + path
            try:
                page.goto(url, wait_until="networkidle", timeout=30_000)
            except Exception as exc:  # noqa: BLE001
                print(f"[warn] {name}: goto {url} -> {exc}", file=sys.stderr)
            page.wait_for_timeout(int(args.settle * 1000))
            target = out / f"{name}.png"
            page.screenshot(path=str(target))
            print(f"{name:22s} {path:28s} -> {target}  ({target.stat().st_size // 1024} KB)")
        browser.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())