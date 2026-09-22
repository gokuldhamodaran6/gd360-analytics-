"""
OAuth plumbing shared by the "live" connectors that authenticate as a
signed-in Google/Microsoft account rather than a database password - Google
Sheets and Microsoft Excel (OneDrive/SharePoint) today, more can be added
later (Google Analytics, Search Console, Google Ads, Meta Ads) the same
way: a provider block here, a matching branch in data_loader.py, without
touching anything else.

What lives here:
  - building the provider's own "sign in and approve" URL (authorize_url)
  - exchanging the one-time code the provider hands back for real tokens
  - refreshing an expired access token using the stored refresh token
  - listing a signed-in person's own spreadsheets/workbooks, so they can
    pick one instead of typing a file id
  - reading/writing the encrypted token blob stored in
    DataSource.encrypted_secret

No customer OAuth token is ever logged or returned to the frontend after
the initial connect - only which spreadsheet/workbook is selected
(DataSource.connection_info) is ever visible to the client, exactly the
same discipline the database/BigQuery connectors already follow for
passwords/service-account keys.
"""
from __future__ import annotations

import json
import time
from urllib.parse import urlencode

import requests
from sqlalchemy.orm import Session

from .. import models, security
from ..config import get_settings

settings = get_settings()

_TIMEOUT = 20
# Refresh an access token a bit before it actually expires, so a request
# already in flight never gets a token that goes stale mid-call.
_EXPIRY_MARGIN_SECONDS = 120


# drive.file (not drive.readonly) is deliberate: drive.readonly is a
# Google "restricted" scope, which requires GD360 to pass Google's full
# CASA security assessment (weeks, renewed annually, real cost) before
# ANY Google user besides a manually-approved tester could connect a
# sheet. drive.file is "non-sensitive" - it only ever grants access to
# the one file a person explicitly selects through Google's own picker
# widget (see ConnectResourcePicker.tsx's GooglePicker + the
# /connections/{id}/picker-token endpoint below), so it skips that
# assessment entirely and only needs Google's much lighter standard
# review to go public. The tradeoff: unlike drive.readonly, this scope
# CANNOT list/search a person's Drive on our own (see the removed
# list_google_spreadsheets, below) - picking a file only ever happens
# through Google's picker, never our own search list.
GOOGLE_SCOPES = "https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/drive.file"
MS_SCOPES = "offline_access Files.Read"


class OAuthNotConfigured(Exception):
    """Raised when the app owner hasn't pasted this provider's Client
    ID/Secret into the environment yet - a clear, actionable error instead
    of a confusing failure deep inside a token exchange."""


class OAuthError(Exception):
    pass


# ---------------------------------------------------------------------------
# Token blob (access_token/refresh_token/expires_at) <-> DataSource.encrypted_secret
# ---------------------------------------------------------------------------

def encode_token_blob(tokens: dict) -> str:
    return security.encrypt_secret(json.dumps(tokens))


def decode_token_blob(encrypted_secret: str) -> dict:
    return json.loads(security.decrypt_secret(encrypted_secret))


def _make_blob(token_response: dict, existing_refresh_token: str | None = None) -> dict:
    """Normalizes a provider token response into the one shape this app
    stores. Google only sends a refresh_token on the very FIRST consent (a
    later re-consent/refresh call omits it), so an already-known
    refresh_token is carried forward when the response doesn't include a
    new one - never overwritten with nothing."""
    expires_in = token_response.get("expires_in", 3600)
    return {
        "access_token": token_response["access_token"],
        "refresh_token": token_response.get("refresh_token") or existing_refresh_token,
        "expires_at": time.time() + float(expires_in),
        "token_type": token_response.get("token_type", "Bearer"),
    }


# ---------------------------------------------------------------------------
# Google
# ---------------------------------------------------------------------------

def google_redirect_uri() -> str:
    return f"{settings.BACKEND_BASE_URL.rstrip('/')}/connections/google/callback"


def google_authorize_url(state: str) -> str:
    if not settings.GOOGLE_OAUTH_CLIENT_ID:
        raise OAuthNotConfigured("Google OAuth is not set up yet (GOOGLE_OAUTH_CLIENT_ID is empty).")
    params = {
        "client_id": settings.GOOGLE_OAUTH_CLIENT_ID,
        "redirect_uri": google_redirect_uri(),
        "response_type": "code",
        "scope": GOOGLE_SCOPES,
        "access_type": "offline",
        # Forces Google to hand back a refresh_token every time, not just on
        # the very first consent - without this, a person who disconnects
        # and reconnects (or whose refresh token GD360 lost) would silently
        # get no refresh_token back and the connection would stop working
        # again in an hour with no way to fix it short of revoking access
        # in their Google account first.
        "prompt": "consent",
        "include_granted_scopes": "true",
        "state": state,
    }
    return f"https://accounts.google.com/o/oauth2/v2/auth?{urlencode(params)}"


def google_exchange_code(code: str) -> dict:
    if not settings.GOOGLE_OAUTH_CLIENT_ID or not settings.GOOGLE_OAUTH_CLIENT_SECRET:
        raise OAuthNotConfigured("Google OAuth is not set up yet.")
    resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "code": code,
            "client_id": settings.GOOGLE_OAUTH_CLIENT_ID,
            "client_secret": settings.GOOGLE_OAUTH_CLIENT_SECRET,
            "redirect_uri": google_redirect_uri(),
            "grant_type": "authorization_code",
        },
        timeout=_TIMEOUT,
    )
    if not resp.ok:
        raise OAuthError(f"Google rejected the sign-in: {resp.text[:300]}")
    return _make_blob(resp.json())


def google_refresh(refresh_token: str) -> dict:
    resp = requests.post(
        "https://oauth2.googleapis.com/token",
        data={
            "refresh_token": refresh_token,
            "client_id": settings.GOOGLE_OAUTH_CLIENT_ID,
            "client_secret": settings.GOOGLE_OAUTH_CLIENT_SECRET,
            "grant_type": "refresh_token",
        },
        timeout=_TIMEOUT,
    )
    if not resp.ok:
        raise OAuthError(
            "Google's access to this spreadsheet has expired or was revoked - reconnect this "
            f"data source. ({resp.text[:200]})"
        )
    return _make_blob(resp.json(), existing_refresh_token=refresh_token)



# There used to be a list_google_spreadsheets() here that searched Drive's
# files.list the same way list_ms_workbooks() below still does for
# Microsoft. It's gone on purpose: that search required the drive.readonly
# scope, and GOOGLE_SCOPES above deliberately dropped that in favor of
# drive.file (see the comment on GOOGLE_SCOPES) so the app can go public
# without Google's restricted-scope security assessment. drive.file
# cannot list/search a person's Drive at all - the only way to pick a
# file under it is Google's own picker widget, which is why Google Sheets
# gets its own GET /connections/{id}/picker-token endpoint (routers/
# connections.py) instead of GET /connections/{id}/resources.


# ---------------------------------------------------------------------------
# Microsoft (OneDrive / SharePoint Excel via Graph)
# ---------------------------------------------------------------------------

def ms_redirect_uri() -> str:
    return f"{settings.BACKEND_BASE_URL.rstrip('/')}/connections/microsoft/callback"


def ms_authorize_url(state: str) -> str:
    if not settings.MS_OAUTH_CLIENT_ID:
        raise OAuthNotConfigured("Microsoft OAuth is not set up yet (MS_OAUTH_CLIENT_ID is empty).")
    params = {
        "client_id": settings.MS_OAUTH_CLIENT_ID,
        "redirect_uri": ms_redirect_uri(),
        "response_type": "code",
        "response_mode": "query",
        "scope": MS_SCOPES,
        "state": state,
    }
    tenant = settings.MS_OAUTH_TENANT or "common"
    return f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize?{urlencode(params)}"


def ms_exchange_code(code: str) -> dict:
    if not settings.MS_OAUTH_CLIENT_ID or not settings.MS_OAUTH_CLIENT_SECRET:
        raise OAuthNotConfigured("Microsoft OAuth is not set up yet.")
    tenant = settings.MS_OAUTH_TENANT or "common"
    resp = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={
            "code": code,
            "client_id": settings.MS_OAUTH_CLIENT_ID,
            "client_secret": settings.MS_OAUTH_CLIENT_SECRET,
            "redirect_uri": ms_redirect_uri(),
            "grant_type": "authorization_code",
            "scope": MS_SCOPES,
        },
        timeout=_TIMEOUT,
    )
    if not resp.ok:
        raise OAuthError(f"Microsoft rejected the sign-in: {resp.text[:300]}")
    return _make_blob(resp.json())


def ms_refresh(refresh_token: str) -> dict:
    tenant = settings.MS_OAUTH_TENANT or "common"
    resp = requests.post(
        f"https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token",
        data={
            "refresh_token": refresh_token,
            "client_id": settings.MS_OAUTH_CLIENT_ID,
            "client_secret": settings.MS_OAUTH_CLIENT_SECRET,
            "grant_type": "refresh_token",
            "scope": MS_SCOPES,
        },
        timeout=_TIMEOUT,
    )
    if not resp.ok:
        raise OAuthError(
            "Microsoft's access to this workbook has expired or was revoked - reconnect this "
            f"data source. ({resp.text[:200]})"
        )
    return _make_blob(resp.json(), existing_refresh_token=refresh_token)


def list_ms_workbooks(access_token: str, search: str = ".xlsx") -> list[dict]:
    """Every Excel workbook in this person's own OneDrive matching `search`
    (defaults to every .xlsx), newest-edited first. Graph's `search()`
    matches on file name and content, so this is a simple, forgiving way to
    surface real workbooks without asking anyone to paste a file id or path."""
    resp = requests.get(
        f"https://graph.microsoft.com/v1.0/me/drive/root/search(q='{search}')",
        headers={"Authorization": f"Bearer {access_token}"},
        params={"$select": "id,name,lastModifiedDateTime,file", "$top": 50},
        timeout=_TIMEOUT,
    )
    if not resp.ok:
        raise OAuthError(f"Could not list your OneDrive Excel files: {resp.text[:300]}")
    items = resp.json().get("value", [])
    # Graph's search() can also match on content inside non-Excel files
    # (a PDF that happens to mention "xlsx" in its text, for instance) -
    # `file` is only present on an actual file item, and its mimeType
    # narrows out anything that isn't really a workbook.
    out = []
    for it in items:
        file_info = it.get("file") or {}
        mime = file_info.get("mimeType", "")
        if "spreadsheet" not in mime and not it.get("name", "").lower().endswith((".xlsx", ".xlsm")):
            continue
        out.append({"id": it["id"], "name": it["name"], "modified_at": it.get("lastModifiedDateTime")})
    return out


# ---------------------------------------------------------------------------
# Access-token resolution: decrypt the stored blob, refresh it if it has
# expired (or is about to), and - when a db session is given - persist the
# rotated tokens back so the NEXT call doesn't have to refresh again.
# Mirrors data_loader.py's existing "decrypt just-in-time, never keep
# plaintext credentials around longer than one request" discipline.
# ---------------------------------------------------------------------------

def get_valid_access_token(ds: models.DataSource, db: Session | None = None) -> str:
    if not ds.encrypted_secret:
        raise OAuthError("This connection has no stored credentials - reconnect this data source.")
    blob = decode_token_blob(ds.encrypted_secret)
    if float(blob.get("expires_at", 0)) > time.time() + _EXPIRY_MARGIN_SECONDS:
        return blob["access_token"]

    refresh_token = blob.get("refresh_token")
    if not refresh_token:
        raise OAuthError(
            "This connection's access has expired and there is no way to silently renew it - "
            "reconnect this data source."
        )

    if ds.kind == "google_sheets":
        fresh = google_refresh(refresh_token)
    elif ds.kind == "microsoft_excel":
        fresh = ms_refresh(refresh_token)
    else:
        raise OAuthError(f"Unsupported OAuth datasource kind: {ds.kind}")

    ds.encrypted_secret = encode_token_blob(fresh)
    if db is not None:
        db.add(ds)
        db.commit()
        db.refresh(ds)
    return fresh["access_token"]
