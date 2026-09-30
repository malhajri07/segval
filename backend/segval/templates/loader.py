from __future__ import annotations

from functools import lru_cache
from pathlib import Path

import yaml
from pydantic import BaseModel

from segval.dsl.model import SegmentDefinition

TEMPLATE_DIR = Path(__file__).parent


class Template(BaseModel):
    id: str
    name: str
    category: str
    description: str = ""
    definition: SegmentDefinition


@lru_cache(maxsize=8)
def load_templates(domain: str = "mobile_b2c") -> tuple[Template, ...]:
    path = TEMPLATE_DIR / f"{domain}.yaml"
    if not path.exists():
        return ()
    with path.open(encoding="utf-8") as fh:
        return tuple(Template.model_validate(t) for t in yaml.safe_load(fh) or [])
