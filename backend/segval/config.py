from __future__ import annotations

from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_prefix="SEGVAL_", env_file=".env", extra="ignore")

    neo4j_uri: str = "bolt://localhost:7687"
    neo4j_user: str = "neo4j"
    neo4j_password: str = "segval-dev-pw"
    neo4j_database: str = "neo4j"
    catalog_domain: str = "mobile_b2c"
    cors_origins: list[str] = ["http://localhost:5173"]
    enable_admin: bool = True
    """Expose /api/admin (schema + synthetic seed). Disable in production."""
    query_timeout_s: float = 60.0
    preview_sample_size: int = 25


@lru_cache
def get_settings() -> Settings:
    return Settings()
