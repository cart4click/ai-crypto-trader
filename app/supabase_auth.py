"""Server-side verification for Supabase Auth user access tokens.

Only the project's publishable key is used here. The IONOS SMTP credentials and
Supabase service-role key never belong in this application.
"""
import httpx
from fastapi import HTTPException, Request

from .config import settings


def _not_configured() -> HTTPException:
    return HTTPException(503, "Supabase authentication is not configured on this server.")


async def get_authenticated_user(request: Request) -> dict:
    """Validate the request's Bearer JWT with Supabase Auth and return its user."""
    if not settings.supabase_url or not settings.supabase_publishable_key:
        raise _not_configured()
    authorization = request.headers.get("Authorization", "")
    if not authorization.startswith("Bearer ") or len(authorization) <= 7:
        raise HTTPException(401, "Sign in is required.")

    try:
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.get(
                f"{settings.supabase_url}/auth/v1/user",
                headers={
                    "apikey": settings.supabase_publishable_key,
                    "Authorization": authorization,
                },
            )
    except httpx.HTTPError as exc:
        raise HTTPException(503, "Authentication service is unavailable. Please try again.") from exc

    if response.status_code != 200:
        raise HTTPException(401, "Your sign-in session is invalid or has expired.")
    user = response.json()
    if not user.get("id") or not user.get("email"):
        raise HTTPException(401, "Your sign-in session is invalid.")
    return user
