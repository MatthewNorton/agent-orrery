"""Rebuild aur-wisp-drone from original procedural geometry."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "_shared"))

from fleet_builder import build_by_slug


raise SystemExit(build_by_slug("aur-wisp-drone", HERE))
