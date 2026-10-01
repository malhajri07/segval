"""Deterministic holdout (control group) assignment.

A member is in the control group when a stable hash of ``segment_id:member_key``
falls below the holdout share. The same member always lands in the same group for
a given segment, so refreshing a segment does not reshuffle who was held out, and
the offline demo (TypeScript FNV-1a) assigns exactly the same members.
"""

from __future__ import annotations

BUCKETS = 10_000


def fnv1a_32(text: str) -> int:
    h = 0x811C9DC5
    for byte in text.encode("utf-8"):
        h ^= byte
        h = (h * 0x01000193) & 0xFFFFFFFF
    return h


def in_control(segment_id: str, member_key: str, holdout_pct: float) -> bool:
    if holdout_pct <= 0:
        return False
    return fnv1a_32(f"{segment_id}:{member_key}") % BUCKETS < round(holdout_pct * BUCKETS / 100)
