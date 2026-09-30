"""Command line entry point: ``segval-seed --customers 5000``."""

from __future__ import annotations

import argparse
import time

from segval.config import get_settings
from segval.graph.client import Neo4jClient
from segval.seed.generator import generate
from segval.seed.loader import load_dataset


def main() -> None:
    parser = argparse.ArgumentParser(description="Load synthetic mobile B2C data into Neo4j")
    parser.add_argument("--customers", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--no-reset", action="store_true", help="keep existing data")
    args = parser.parse_args()

    started = time.time()
    ds = generate(customers=args.customers, seed=args.seed)
    client = Neo4jClient(get_settings())
    try:
        summary = load_dataset(client, ds, reset=not args.no_reset,
                               progress=lambda m: print(f"  loading {m}"))
    finally:
        client.close()
    print(f"as_of={ds.as_of} {summary} in {time.time() - started:.1f}s")


if __name__ == "__main__":
    main()
