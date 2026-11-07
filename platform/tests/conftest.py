from __future__ import annotations

import itertools
from collections.abc import Callable

import pytest

from oxford_hack.harness.sim import Sim
from oxford_hack.harness.synthetic import QualityEvent, simulation_factory
from oxford_hack.session.hub import Hub, HubSettings, IdFactory
from oxford_hack.timing.clock import ManualClock

_instances = itertools.count(1)


def make_hub_factory(
    *,
    period_ms: float = 20_000.0,
    script: tuple[QualityEvent, ...] = (),
    settings: HubSettings | None = None,
    instance: int | None = None,
) -> Callable[[ManualClock], Hub]:
    def factory(clock: ManualClock) -> Hub:
        n = instance if instance is not None else next(_instances)
        return Hub(
            clock,
            settings=settings,
            simulation_factory=simulation_factory(period_ms=period_ms, script=script),
            ids=IdFactory(seed=f"h{n}"),
            backend_instance_id=f"be-test-{n}",
        )

    return factory


@pytest.fixture
def sim() -> Sim:
    return Sim(make_hub_factory())
