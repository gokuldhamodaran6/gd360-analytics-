"""
2026-10-09 (round 15): "Sign in with ..." for synced apps.

Instead of pasting a token, a person signs in with the app's owner account:

  1. GET /apps/oauth/{kind}/start      -> authorize_url(kind, user): the
     provider's consent page, with a signed state naming the user, provider
     and kind (security.create_oauth_state, purpose "app:<provider>:<kind>").
  2. the provider sends the browser to /apps/oauth/{provider}/callback ->
     read_state() + exchange_code(): tokens, stored encrypted in a
     models.AppAuthPending row (store_pending), and the browser goes back to
     the connect sheet with that row's id.
  3. POST /apps/discover or POST /apps with pending_id -> pending_credentials():
     the tokens as the connector expects them (meta -> access_token; google ->
     refresh_token + client id/secret; linkedin -> access_token (+refresh_token);
     hubspot -> access_token + refresh_token).

A pending row is usable only by the person who signed in, and only for
PENDING_MINUTES. Nothing here is ever logged with its token.
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta
from urllib.parse import urlencode

import requests
from jose import jwt
from sqlalchemy.orm import Session

from .. import models, security
from ..config import get_settings

PENDING_MINUTES = 30
HTTP_TIMEOUT = 30

PROVIDERS = ("meta", "google", "linkedin", "hubspot")
PROVIDER_LABELS = {"meta": "Meta (Facebook)", "google": "Google", "linkedin": "LinkedIn", "hubspot": "HubSpot"}

# Which provider each app signs in through. app_connectors.HELP[kind]
# ["oauth_provider"] wins when present; this covers the existing apps too.
KIND_PROVIDER = {
    "instagram": "meta", "facebook_pages": "meta", "meta_ads": "meta",
    "youtube": "google", "search_console": "google", "ga4": "google", "google_ads": "google",
    "linkedin_pages": "linkedin",
    "hubspot": "hubspot",
}

META_SCOPES = ["pages_show_list", "pages_read_engagement", "read_insights", "instagram_basic",
               "instagram_manage_insights", "ads_read", "business_management"]
GOOGLE_SCOPES = {
    "youtube": ["https://www.googleapis.com/auth/youtube.readonly",
                "https://www.googleapis.com/auth/yt-analytics.readonly"],
    "search_console": ["https://www.googleapis.com/auth/webmasters.readonly"],
    "ga4": ["https://www.googleapis.com/auth/analytics.readonly"],
    "google_ads": ["https://www.googleapis.com/auth/adwords"],
}
LINKEDIN_SCOPES = ["r_organization_social", "rw_organization_admin", "r_organization_admin"]
HUBSPOT_SCOPES = ["crm.objects.contacts.read", "crm.objects.deals.read", "crm.objects.companies.read",
                  "crm.objects.owners.read"]

_ENV = {
    "meta": ("META_APP_ID", "META_APP_SECRET"),
    "google": ("GOOGLE_OAUTH_CLIENT_ID", "GOOGLE_OAUTH_CLIENT_SECRET"),
    "linkedin": ("LINKEDIN_CLIENT_ID", "LINKEDIN_CLIENT_SECRET"),
    "hubspot": ("HUBSPOT_CLIENT_ID", "HUBSPOT_CLIENT_SECRET"),
}


class OAuthError(RuntimeError):
    """Something the person can act on (cancelled, expired, not configured)."""


def provider_for(kind: str) -> str | None:
    try:
        from . import app_connectors
        help_ = (getattr(app_connectors, "HELP", {}) or {}).get(kind) or {}
        if "oauth_provider" in help_:
            return help_.get("oauth_provider")
    except Exception:  # noqa: BLE001
        pass
    return KIND_PROVIDER.get(kind)


def env_names(provider: str) -> tuple[str, str]:
    return _ENV[provider]


def client(provider: str) -> tuple[str, str]:
    s = get_settings()
    a, b = _ENV[provider]
    return (getattr(s, a, "") or "").strip(), (getattr(s, b, "") or "").strip()


def configured(provider: str | None) -> bool:
    if provider not in _ENV:
        return False
    cid, secret = client(provider)
    return bool(cid and secret)


def redirect_uri(provider: str) -> str:
    return f"{get_settings().BACKEND_BASE_URL.rstrip('/')}/apps/oauth/{provider}/callback"


def _purpose(provider: str, kind: str) -> str:
    return f"app:{provider}:{kind}"


def authorize_url(kind: str, user: models.User) -> str:
    provider = provider_for(kind)
    if provider not in _ENV:
        raise OAuthError(f"{kind} does not use a sign-in page; paste its key instead.")
    if not configured(provider):
        a, b = _ENV[provider]
        raise OAuthError(f"Sign-in with {PROVIDER_LABELS[provider]} is not set up on this server yet. "
                         f"An admin needs to set {a} and {b}.")
    s = get_settings()
    cid, _ = client(provider)
    state = security.create_oauth_state(user.id, _purpose(provider, kind))
    common = {"client_id": cid, "redirect_uri": redirect_uri(provider), "state": state, "response_type": "code"}
    if provider == "meta":
        return f"https://www.facebook.com/{s.META_GRAPH_VERSION}/dialog/oauth?" + urlencode(
            {**common, "scope": ",".join(META_SCOPES)})
    if provider == "google":
        scopes = GOOGLE_SCOPES.get(kind)
        if not scopes:
            raise OAuthError(f"{kind} does not sign in with Google.")
        return "https://accounts.google.com/o/oauth2/v2/auth?" + urlencode(
            {**common, "scope": " ".join(scopes), "access_type": "offline", "prompt": "consent",
             "include_granted_scopes": "true"})
    if provider == "linkedin":
        return "https://www.linkedin.com/oauth/v2/authorization?" + urlencode(
            {**common, "scope": " ".join(LINKEDIN_SCOPES)})
    return "https://app.hubspot.com/oauth/authorize?" + urlencode({**common, "scope": " ".join(HUBSPOT_SCOPES)})


def read_state(state: str, provider: str) -> tuple[str, str]:
    """(user_id, kind) from a callback's state, or OAuthError. The signature,
    expiry and provider are all checked (security.decode_oauth_state)."""
    try:
        purpose = str(jwt.get_unverified_claims(state or "").get("provider") or "")
    except Exception as e:  # noqa: BLE001
        raise OAuthError("This sign-in link is not valid. Start again from the connect page.") from e
    parts = purpose.split(":")
    if len(parts) != 3 or parts[0] != "app" or parts[1] != provider:
        raise OAuthError("This sign-in link is not valid. Start again from the connect page.")
    user_id = security.decode_oauth_state(state, purpose)
    if not user_id:
        raise OAuthError("The sign-in took too long or the link is not valid. Start again from the connect page.")
    return user_id, parts[2]


def kind_from_state(state: str) -> str | None:
    """Best-effort kind for an error redirect, without trusting the token."""
    try:
        parts = str(jwt.get_unverified_claims(state or "").get("provider") or "").split(":")
        return parts[2] if len(parts) == 3 and parts[0] == "app" else None
    except Exception:  # noqa: BLE001
        return None


def _json(r: requests.Response, who: str) -> dict:
    try:
        body = r.json()
    except ValueError:
        body = {}
    if r.status_code >= 400 or not isinstance(body, dict):
        msg = ""
        if isinstance(body, dict):
            err = body.get("error")
            msg = (err.get("message") if isinstance(err, dict) else body.get("error_description") or body.get("message")
                   or (err if isinstance(err, str) else "")) or ""
        raise OAuthError(f"{who} did not accept the sign-in ({r.status_code}). {msg}".strip())
    return body


def _call(method, url: str, who: str, **kw) -> dict:
    try:
        r = method(url, timeout=HTTP_TIMEOUT, **kw)
    except requests.RequestException as e:
        raise OAuthError(f"Could not reach {who} to finish the sign-in. Try again in a minute.") from e
    return _json(r, who)


def exchange_code(provider: str, code: str) -> dict:
    """Swap the callback's code for tokens: {"access_token", "refresh_token"?,
    "expires_in"?, "scope"?}. Meta's short-lived token is swapped for a
    long-lived (about 60 days) one."""
    if not code:
        raise OAuthError("The sign-in did not return a code. Start again from the connect page.")
    s = get_settings()
    cid, secret = client(provider)
    ruri = redirect_uri(provider)
    if provider == "meta":
        url = f"https://graph.facebook.com/{s.META_GRAPH_VERSION}/oauth/access_token"
        short = _call(requests.get, url, "Meta", params={"client_id": cid, "client_secret": secret,
                                                         "redirect_uri": ruri, "code": code})
        if not short.get("access_token"):
            raise OAuthError("Meta did not return an access token.")
        long = _call(requests.get, url, "Meta", params={"grant_type": "fb_exchange_token", "client_id": cid,
                                                        "client_secret": secret,
                                                        "fb_exchange_token": short["access_token"]})
        return {"access_token": long.get("access_token") or short["access_token"],
                "expires_in": long.get("expires_in") or short.get("expires_in")}
    if provider == "google":
        tok = _call(requests.post, "https://oauth2.googleapis.com/token", "Google",
                    data={"code": code, "client_id": cid, "client_secret": secret, "redirect_uri": ruri,
                          "grant_type": "authorization_code"})
        if not tok.get("refresh_token"):
            raise OAuthError("Google did not return a long-lived token. Remove GD360 from "
                             "myaccount.google.com/permissions and sign in again.")
        return {k: tok.get(k) for k in ("access_token", "refresh_token", "expires_in", "scope") if tok.get(k)}
    if provider == "linkedin":
        tok = _call(requests.post, "https://www.linkedin.com/oauth/v2/accessToken", "LinkedIn",
                    data={"grant_type": "authorization_code", "code": code, "redirect_uri": ruri,
                          "client_id": cid, "client_secret": secret})
    elif provider == "hubspot":
        tok = _call(requests.post, "https://api.hubapi.com/oauth/v1/token", "HubSpot",
                    data={"grant_type": "authorization_code", "code": code, "redirect_uri": ruri,
                          "client_id": cid, "client_secret": secret})
    else:
        raise OAuthError("Unknown sign-in provider.")
    if not tok.get("access_token"):
        raise OAuthError(f"{PROVIDER_LABELS[provider]} did not return an access token.")
    return {k: tok.get(k) for k in ("access_token", "refresh_token", "expires_in", "refresh_token_expires_in", "scope")
            if tok.get(k)}


def store_pending(db: Session, user_id: str, provider: str, kind: str, tokens: dict) -> models.AppAuthPending:
    # Old hand-offs are cleaned up whenever a new one is stored.
    cutoff = datetime.utcnow() - timedelta(minutes=PENDING_MINUTES)
    db.query(models.AppAuthPending).filter(models.AppAuthPending.created_at < cutoff).delete(synchronize_session=False)
    note = {"scope": tokens.get("scope"), "expires_in": tokens.get("expires_in"),
            "has_refresh_token": bool(tokens.get("refresh_token"))}
    row = models.AppAuthPending(user_id=user_id, provider=provider, kind=kind,
                                encrypted_tokens=security.encrypt_secret(json.dumps(tokens)), state_note=note)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def get_pending(db: Session, pending_id: str, user: models.User, kind: str | None = None) -> models.AppAuthPending:
    row = db.get(models.AppAuthPending, pending_id) if pending_id else None
    if not row or row.user_id != user.id:
        raise OAuthError("That sign-in was not found. Sign in again.")
    if row.created_at < datetime.utcnow() - timedelta(minutes=PENDING_MINUTES):
        db.delete(row)
        db.commit()
        raise OAuthError("That sign-in expired (they last 30 minutes). Sign in again.")
    if kind and row.kind != kind and provider_for(kind) != row.provider:
        raise OAuthError("That sign-in was for a different app. Sign in again.")
    return row


def pending_credentials(row: models.AppAuthPending) -> dict:
    """The tokens in the shape each connector reads."""
    tokens = json.loads(security.decrypt_secret(row.encrypted_tokens) or "{}")
    if row.provider == "meta":
        return {"access_token": tokens.get("access_token")}
    if row.provider == "google":
        cid, secret = client("google")
        return {"refresh_token": tokens.get("refresh_token"), "client_id": cid, "client_secret": secret}
    out = {"access_token": tokens.get("access_token")}
    if tokens.get("refresh_token"):
        out["refresh_token"] = tokens["refresh_token"]
    return {k: v for k, v in out.items() if v}


def frontend_return(kind: str | None, pending_id: str | None = None, error: str | None = None) -> str:
    q = {"tab": "catalog"}
    if kind:
        q["connect"] = kind
    if pending_id:
        q["pending"] = pending_id
    if error:
        q["error"] = error[:300]
    return f"{get_settings().FRONTEND_ORIGIN.rstrip('/')}/data?" + urlencode(q)
