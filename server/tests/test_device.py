"""Which torch device the server runs on: NVIDIA, Apple silicon or, only when
asked for, the CPU."""

import pytest
from conftest import srv


@pytest.mark.parametrize(
    ("requested", "cuda", "mps", "device"),
    [
        (None, True, False, "cuda"),
        (None, True, True, "cuda"),
        (None, False, True, "mps"),
        ("", False, True, "mps"),
        ("cpu", False, False, "cpu"),
        ("cpu", True, True, "cpu"),
        ("mps", True, True, "mps"),
        ("cuda", True, False, "cuda"),
    ],
)
def test_picks_a_device(requested, cuda, mps, device):
    assert srv._pick_device(requested, cuda, mps) == device


@pytest.mark.parametrize(
    ("requested", "cuda", "mps"),
    [
        (None, False, False),  # never the CPU by itself
        ("cuda", False, True),
        ("mps", True, False),
        ("tpu", True, True),
    ],
)
def test_refuses_what_it_cannot_run_on(requested, cuda, mps):
    with pytest.raises(RuntimeError):
        srv._pick_device(requested, cuda, mps)
