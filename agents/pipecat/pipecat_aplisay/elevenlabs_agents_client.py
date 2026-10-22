"""The ElevenLabs Agents REST surface the worker uses: find or create the
hosted agent for a configuration, and mint the signed URL a conversation
joins with. See docs/elevenlabs-agents.md.

The hosted agent is found by name. The name carries the configuration
digest (:func:`elevenlabs_agents.agent_name`), so every worker process, and
every deployment sharing the prefix, converges on the same agent without
any shared state of the platform's own. Creation takes about three seconds
(measured 2026-10-22), lookup about 200 ms, and a process remembers what it
has found, so only the first call on a new configuration pays.
"""

from __future__ import annotations

import asyncio
from typing import Any, Optional

import httpx
from loguru import logger

from . import elevenlabs_agents as el
from .http_client import get_client

#: Fits a create (about 3 s) with margin; a lookup or a signed URL is far quicker.
REQUEST_TIMEOUT_SECS = 20.0


class ElevenLabsAgentsError(RuntimeError):
    """A failed ElevenLabs request, with the status and body for the logs."""

    def __init__(self, what: str, status: Optional[int] = None, body: str = "") -> None:
        detail = f" ({status})" if status is not None else ""
        super().__init__(f"ElevenLabs {what} failed{detail}: {body[:300]}")
        self.status = status
        self.body = body


# name -> agent_id, shared by every session in the process.
_known_agents: dict[str, str] = {}
_locks: dict[str, asyncio.Lock] = {}


def forget_known_agents() -> None:
    """Drop the process cache (tests, and a 404 on a cached id)."""
    _known_agents.clear()


class ElevenLabsAgentsClient:
    def __init__(self, api_key: str, *, base_url: Optional[str] = None, http: Optional[httpx.AsyncClient] = None) -> None:
        self._api_key = api_key
        self._base_url = (base_url or el.api_base()).rstrip("/")
        self._http = http

    async def _client(self) -> httpx.AsyncClient:
        if self._http is not None:
            return self._http
        return await get_client("elevenlabs-agents")

    async def _request(self, method: str, path: str, *, what: str, **kwargs: Any) -> httpx.Response:
        client = await self._client()
        headers = {"xi-api-key": self._api_key, **kwargs.pop("headers", {})}
        try:
            response = await client.request(
                method, f"{self._base_url}{path}", headers=headers, timeout=REQUEST_TIMEOUT_SECS, **kwargs
            )
        except httpx.HTTPError as e:
            raise ElevenLabsAgentsError(what, body=str(e)) from e
        if response.status_code >= 400:
            raise ElevenLabsAgentsError(what, response.status_code, response.text)
        return response

    # ---- agents -------------------------------------------------------------

    async def find_agent(self, name: str) -> Optional[str]:
        """The id of the agent named exactly ``name``, or None."""
        response = await self._request(
            "GET", "/v1/convai/agents", what="agent lookup", params={"search": name, "page_size": 100}
        )
        for entry in (response.json() or {}).get("agents") or []:
            if entry.get("name") == name and entry.get("agent_id"):
                return str(entry["agent_id"])
        return None

    async def create_agent(self, body: dict) -> str:
        response = await self._request("POST", "/v1/convai/agents/create", what="agent create", json=body)
        agent_id = (response.json() or {}).get("agent_id")
        if not agent_id:
            raise ElevenLabsAgentsError("agent create", response.status_code, response.text)
        return str(agent_id)

    async def ensure_agent(self, config: dict) -> str:
        """The hosted agent for ``config``: remembered, found by name, or created."""
        name = el.agent_name(el.config_hash(config))
        cached = _known_agents.get(name)
        if cached:
            return cached
        lock = _locks.setdefault(name, asyncio.Lock())
        async with lock:
            cached = _known_agents.get(name)
            if cached:
                return cached
            agent_id = await self.find_agent(name)
            if agent_id:
                logger.bind(name=name, agent_id=agent_id).info("ElevenLabs agent found")
            else:
                agent_id = await self.create_agent(el.create_body(config, name=name))
                logger.bind(name=name, agent_id=agent_id).info("ElevenLabs agent created")
            _known_agents[name] = agent_id
            return agent_id

    async def signed_url(self, agent_id: str) -> str:
        response = await self._request(
            "GET", "/v1/convai/conversation/get-signed-url", what="signed url", params={"agent_id": agent_id}
        )
        url = (response.json() or {}).get("signed_url")
        if not url:
            raise ElevenLabsAgentsError("signed url", response.status_code, response.text)
        return str(url)

    async def conversation_url(self, config: dict) -> tuple[str, str]:
        """``(agent_id, signed_url)`` for a conversation on ``config``. An agent
        the workspace no longer has (deleted behind the cache) is forgotten
        and recreated once."""
        agent_id = await self.ensure_agent(config)
        try:
            return agent_id, await self.signed_url(agent_id)
        except ElevenLabsAgentsError as e:
            if e.status not in (400, 404):
                raise
            name = el.agent_name(el.config_hash(config))
            logger.bind(agent_id=agent_id, status=e.status).warning("ElevenLabs agent gone; recreating")
            _known_agents.pop(name, None)
            agent_id = await self.ensure_agent(config)
            return agent_id, await self.signed_url(agent_id)

    # ---- housekeeping (scripts and tests) -----------------------------------

    async def list_agents(self, *, search: Optional[str] = None) -> list[dict]:
        agents: list[dict] = []
        cursor: Optional[str] = None
        while True:
            params: dict = {"page_size": 100}
            if search:
                params["search"] = search
            if cursor:
                params["cursor"] = cursor
            body = self._json(await self._request("GET", "/v1/convai/agents", what="agent list", params=params))
            agents.extend(body.get("agents") or [])
            if not body.get("has_more") or not body.get("next_cursor"):
                return agents
            cursor = body["next_cursor"]

    async def get_agent(self, agent_id: str) -> dict:
        return self._json(await self._request("GET", f"/v1/convai/agents/{agent_id}", what="agent get"))

    async def delete_agent(self, agent_id: str) -> None:
        await self._request("DELETE", f"/v1/convai/agents/{agent_id}", what="agent delete")
        for name, known in list(_known_agents.items()):
            if known == agent_id:
                _known_agents.pop(name, None)

    async def delete_tool(self, tool_id: str) -> bool:
        """Delete a tool. A deleted agent still counts as a dependant unless the
        delete is forced; a live dependant still answers 409 (returned False)."""
        try:
            await self._request("DELETE", f"/v1/convai/tools/{tool_id}", what="tool delete", params={"force": "true"})
            return True
        except ElevenLabsAgentsError as e:
            if e.status == 409:
                return False
            raise

    @staticmethod
    def _json(response: httpx.Response) -> dict:
        try:
            body = response.json()
        except ValueError:
            return {}
        return body if isinstance(body, dict) else {}
