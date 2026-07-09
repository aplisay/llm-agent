"""Build/version identity, logged once at worker startup so a running process
always says exactly which code it is — the same trick the Node runtime uses
(``lib/build-info.js``) to catch stale deploys: a green build that never rolled,
or cluster pods that haven't re-pulled a mutable ``:next`` image.

Sources, in order:
  1. ``BUILD_COMMIT`` / ``BUILD_BRANCH`` / ``BUILD_TAG`` env — baked into the
     image by the Dockerfile from Cloud Build's ``COMMIT_SHA`` / ``BRANCH_NAME``
     / ``TAG_NAME`` substitutions (see ``agents/pipecat/Dockerfile`` and
     ``deploy/gcp/cloudbuild-staging.yaml``).
  2. git (dev fallback — local runs from a checkout).
  3. ``"unknown"``.
"""

from __future__ import annotations

import os
import subprocess
from pathlib import Path

# agents/pipecat — the worker package's parent; git fallback only resolves here
# in a dev checkout (the image copies the tree without .git).
_REPO_ROOT = Path(__file__).resolve().parents[1]


def _git(*args: str) -> str | None:
    try:
        out = subprocess.run(
            ["git", *args],
            cwd=_REPO_ROOT,
            capture_output=True,
            text=True,
            timeout=2,
        )
    except Exception:
        return None
    if out.returncode != 0:
        return None
    return out.stdout.strip() or None


def build_info() -> dict:
    """``{commit, branch, tag, source: 'env'|'git'|'unknown'}`` — fields ``None`` when unknown."""
    commit = (os.environ.get("BUILD_COMMIT") or "").strip() or None
    branch = (os.environ.get("BUILD_BRANCH") or "").strip() or None
    tag = (os.environ.get("BUILD_TAG") or "").strip() or None
    if commit:
        return {"commit": commit, "branch": branch, "tag": tag, "source": "env"}

    commit = _git("rev-parse", "--short=12", "HEAD")
    if commit:
        return {
            "commit": commit,
            "branch": _git("rev-parse", "--abbrev-ref", "HEAD"),
            "tag": _git("describe", "--tags", "--exact-match"),
            "source": "git",
        }
    return {"commit": None, "branch": None, "tag": None, "source": "unknown"}


def describe_build(info: dict | None = None) -> str:
    """One-line human summary, e.g. ``commit d01ed576eeb7 (branch next) [git]``."""
    info = info or build_info()
    if not info.get("commit"):
        return "unknown (no BUILD_COMMIT baked and no git checkout)"
    tag = f" tag {info['tag']}" if info.get("tag") else ""
    branch = f" (branch {info['branch']})" if info.get("branch") else ""
    return f"commit {info['commit']}{tag}{branch} [{info['source']}]"
