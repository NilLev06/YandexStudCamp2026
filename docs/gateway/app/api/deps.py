from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import Depends, Header, HTTPException, Request, status

from ..registry import Registry
from ..settings import Settings


def get_registry(request: Request) -> Registry:
    return request.app.state.registry


def get_settings(request: Request) -> Settings:
    return request.app.state.settings


def require_api_key(
    settings: Annotated[Settings, Depends(get_settings)],
    x_api_key: Annotated[str | None, Header(description='Ключ доступа, если задан GATEWAY_API_KEY')] = None,
) -> None:
    if settings.api_key and not (x_api_key and secrets.compare_digest(x_api_key, settings.api_key)):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, 'Неверный или отсутствующий X-API-Key')


RegistryDep = Annotated[Registry, Depends(get_registry)]
SettingsDep = Annotated[Settings, Depends(get_settings)]
WriteAccess = Depends(require_api_key)
