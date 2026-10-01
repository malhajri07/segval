from segval.services.holdout import fnv1a_32, in_control


def test_fnv1a_reference_vectors():
    # Published FNV-1a 32-bit test vectors.
    assert fnv1a_32("") == 0x811C9DC5
    assert fnv1a_32("a") == 0xE40C292C
    assert fnv1a_32("foobar") == 0xBF9CF968


def test_holdout_share_and_stability():
    keys = [f"9665{i:08d}" for i in range(20_000)]
    control = [k for k in keys if in_control("seg1", k, 10)]
    assert 0.09 < len(control) / len(keys) < 0.11
    assert control == [k for k in keys if in_control("seg1", k, 10)]
    # a different segment holds out a different set of members
    assert control != [k for k in keys if in_control("seg2", k, 10)]
    assert not any(in_control("seg1", k, 0) for k in keys[:100])
