from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml

from segval.catalog.model import Catalog

CATALOG_DIR = Path(__file__).parent


def load_catalog_file(path: Path) -> Catalog:
    with path.open(encoding="utf-8") as fh:
        return Catalog.model_validate(yaml.safe_load(fh))


@lru_cache(maxsize=8)
def load_catalog(domain: str = "mobile_b2c") -> Catalog:
    return load_catalog_file(CATALOG_DIR / f"{domain}.yaml")
