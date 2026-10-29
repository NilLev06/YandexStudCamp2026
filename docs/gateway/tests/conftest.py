from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.settings import Settings


class FakeClock:
    def __init__(self, start: float = 1_761_600_000.0) -> None:
        self.now = start

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


@pytest.fixture
def clock() -> FakeClock:
    return FakeClock()


@pytest.fixture
def make_client(clock):
    clients = []

    def factory(**overrides) -> TestClient:
        settings = Settings(_env_file=None, **{'static_dir': None, **overrides})
        client = TestClient(create_app(settings, start_ticker=False, time_fn=clock))
        client.__enter__()
        clients.append(client)
        return client

    yield factory
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()


@pytest.fixture
def registry(client):
    return client.app.state.registry
