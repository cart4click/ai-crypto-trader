"""Email one-time-code authentication for the dashboard."""
import asyncio
import hashlib
import hmac
import logging
import re
import secrets
import smtplib
import ssl
import time
from email.message import EmailMessage

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from .config import settings

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth", tags=["authentication"])
_otp_key = secrets.token_bytes(32)
_challenges: dict[str, dict] = {}
_last_email_send: dict[str, float] = {}
_ip_sends: dict[str, list[float]] = {}
_sessions: dict[str, dict] = {}
_lock = asyncio.Lock()
_EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class CodeRequest(BaseModel):
    first_name: str = ""
    last_name: str = ""
    email: str


class CodeVerify(BaseModel):
    challenge_id: str
    code: str


def _send_code_email(recipient: str, first_name: str, code: str) -> None:
    message = EmailMessage()
    message["Subject"] = "Your AI Crypto Trader sign-in code"
    message["From"] = settings.smtp_from_email
    message["To"] = recipient
    message.set_content(
        f"Hi {first_name},\n\nYour sign-in code is {code}. It expires in 10 minutes.\n"
        "If you did not request this code, you can ignore this email.\n"
    )
    context = ssl.create_default_context()
    if settings.smtp_port == 465:
        with smtplib.SMTP_SSL(settings.smtp_host, settings.smtp_port, timeout=15, context=context) as smtp:
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(message)
    else:
        with smtplib.SMTP(settings.smtp_host, settings.smtp_port, timeout=15) as smtp:
            smtp.ehlo()
            smtp.starttls(context=context)
            smtp.ehlo()
            if settings.smtp_username:
                smtp.login(settings.smtp_username, settings.smtp_password)
            smtp.send_message(message)


@router.post("/request-code")
async def request_code(body: CodeRequest, request: Request):
    first_name, last_name = body.first_name.strip(), body.last_name.strip()
    email = body.email.strip().lower()
    if bool(first_name) != bool(last_name):
        raise HTTPException(400, "Enter both first and last name, or leave both blank to log in.")
    if len(first_name) > 60 or len(last_name) > 60:
        raise HTTPException(400, "Names must be 60 characters maximum.")
    first_name = first_name or "there"
    if len(email) > 254 or not _EMAIL_RE.fullmatch(email):
        raise HTTPException(400, "Enter a valid email address.")
    if not all((settings.smtp_host, settings.smtp_from_email)):
        raise HTTPException(503, "Email sign-in is not configured on the server yet.")

    now = time.time()
    ip = request.client.host if request.client else "unknown"
    async with _lock:
        for key, challenge in list(_challenges.items()):
            if challenge["expires"] <= now:
                _challenges.pop(key, None)
        if now - _last_email_send.get(email, 0) < 60:
            raise HTTPException(429, "Please wait a minute before requesting another code.")
        recent_ip_sends = [stamp for stamp in _ip_sends.get(ip, []) if now - stamp < 600]
        if len(recent_ip_sends) >= 5:
            raise HTTPException(429, "Too many code requests. Please try again in a few minutes.")
        _last_email_send[email] = now
        _ip_sends[ip] = recent_ip_sends + [now]

    code = f"{secrets.randbelow(1_000_000):06d}"
    try:
        await asyncio.to_thread(_send_code_email, email, first_name, code)
    except Exception as exc:
        log.warning("Could not send sign-in email: %s", type(exc).__name__)
        raise HTTPException(503, "We could not send the email. Check the address or try again later.") from exc

    challenge_id = secrets.token_urlsafe(24)
    digest = hmac.new(_otp_key, f"{challenge_id}:{code}".encode(), hashlib.sha256).hexdigest()
    async with _lock:
        _challenges[challenge_id] = {
            "first_name": first_name, "last_name": last_name, "email": email,
            "digest": digest, "expires": now + 600, "attempts": 0,
        }
    return {"ok": True, "challenge_id": challenge_id, "message": "If the address can receive mail, a sign-in code is on its way."}


@router.post("/verify-code")
async def verify_code(body: CodeVerify):
    if not body.challenge_id or not body.code.isdigit() or len(body.code) != 6:
        raise HTTPException(400, "Enter the six-digit code from your email.")
    async with _lock:
        challenge = _challenges.get(body.challenge_id)
        if not challenge or challenge["expires"] <= time.time():
            _challenges.pop(body.challenge_id, None)
            raise HTTPException(400, "That code expired. Request a new one.")
        expected = hmac.new(_otp_key, f"{body.challenge_id}:{body.code}".encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, challenge["digest"]):
            challenge["attempts"] += 1
            if challenge["attempts"] >= 5:
                _challenges.pop(body.challenge_id, None)
                raise HTTPException(429, "Too many incorrect attempts. Request a new code.")
            raise HTTPException(400, f"That code is incorrect. {5 - challenge['attempts']} attempts remain.")
        _challenges.pop(body.challenge_id, None)
        session_id = secrets.token_urlsafe(32)
        user = {key: challenge[key] for key in ("first_name", "last_name", "email")}
        _sessions[session_id] = {**user, "expires": time.time() + 30 * 24 * 60 * 60}
    return {"ok": True, "session_token": session_id, "user": user}


@router.get("/session")
async def get_session(request: Request):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    async with _lock:
        session = _sessions.get(token)
        if not session or session["expires"] <= time.time():
            _sessions.pop(token, None)
            raise HTTPException(401, "Sign-in expired.")
        return {"user": {key: session[key] for key in ("first_name", "last_name", "email")}}


@router.post("/logout")
async def logout(request: Request):
    token = request.headers.get("Authorization", "").removeprefix("Bearer ")
    async with _lock:
        _sessions.pop(token, None)
    return {"ok": True}
