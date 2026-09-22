"""
Live OAuth connectors: Google Sheets and Microsoft Excel (OneDrive/
SharePoint). Unlike every connector in routers/datasources.py, these never
take a password/key from a form - the person signs in on Google's or
Microsoft's own site and approves read-only access, and this router never
sees their Google/Microsoft password at all, only the resulting tokens.

The flow, for either provider:
  1. GET /connections/<provider>/authorize (signed in) - returns a URL on
     Google's/Microsoft's own site to send the browser to.
  2. The person signs in and approves there. The provider redirects the
     browser back to GET /connections/<provider>/callback - this request
     is NOT authenticated (no cookie/Authorization header reaches it, since
     the browser was just on a totally different site) - `state` is what
     proves which GD360 user this belongs to (see security.create_oauth_
     state/decode_oauth_state). This exchanges the one-time `code` for
     real tokens, stores them on a new, still-"pending" DataSource row (not
     yet a usable data source - see list_datasources's own filter for
     pending rows), and redirects the browser into the frontend's own
     picker page.
  3. GET /connections/<id>/resources - now back in the app, signed in as
     normal - lists the person's own spreadsheets/workbooks so they can
     pick one instead of pasting a file id.
  4. POST /connections/<id>/finish - saves which one was picked, tests the
     connection for real, introspects its schema exactly like every other
     connector in datasources.py, and turns the pending row into a genuine,
     usable data source.

Abandoning the flow after step 2 (closing the tab, picking nothing) just
leaves a harmless pending row behind - invisible everywhere else (see
list_datasources), and removable with the ordinary
DELETE /datasources/{id} endpoint like any other data source.
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy.orm import Session

from .. import models, schemas
from ..config import get_settings
from ..database import get_db
from ..deps import get_current_user
from ..security import create_oauth_state, decode_oauth_state
from ..services import oauth_tokens
from ..services.connectors import GoogleSheetsConnector, MicrosoftExcelConnector

router = APIRouter(prefix="/connections", tags=["connections"])
settings = get_settings()

_PENDING_NAME = {"google_sheets": "Google Sheets (connecting…)", "microsoft_excel": "Excel (connecting…)"}


def _frontend_redirect(path: str) -> str:
    return f"{settings.FRONTEND_ORIGIN.rstrip('/')}{path}"


# ---------------------------------------------------------------------------
# Google Sheets
# ---------------------------------------------------------------------------

@router.get("/google/authorize", response_model=schemas.OAuthAuthorizeOut)
def google_authorize(user: models.User = Depends(get_current_user)):
    try:
        url = oauth_tokens.google_authorize_url(create_oauth_state(user.id, "google"))
    except oauth_tokens.OAuthNotConfigured as e:
        raise HTTPException(503, str(e))
    return {"authorize_url": url}


@router.get("/google/callback")
def google_callback(code: str | None = None, state: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    if error or not code or not state:
        return RedirectResponse(_frontend_redirect(f"/connect/error?provider=google_sheets&reason={error or 'missing_code'}"))

    user_id = decode_oauth_state(state, "google")
    if not user_id:
        return RedirectResponse(_frontend_redirect("/connect/error?provider=google_sheets&reason=bad_state"))

    try:
        tokens = oauth_tokens.google_exchange_code(code)
    except (oauth_tokens.OAuthError, oauth_tokens.OAuthNotConfigured) as e:
        print(f"[connections] Google token exchange failed: {e}")
        return RedirectResponse(_frontend_redirect("/connect/error?provider=google_sheets&reason=token_exchange"))

    ds = models.DataSource(
        owner_id=user_id,
        name=_PENDING_NAME["google_sheets"],
        kind="google_sheets",
        connection_info={"pending": True},
        encrypted_secret=oauth_tokens.encode_token_blob(tokens),
        read_only=True,
        schema_cache={},
    )
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return RedirectResponse(_frontend_redirect(f"/connect/google_sheets?connection_id={ds.id}"))


# ---------------------------------------------------------------------------
# Microsoft Excel (OneDrive / SharePoint)
# ---------------------------------------------------------------------------

@router.get("/microsoft/authorize", response_model=schemas.OAuthAuthorizeOut)
def microsoft_authorize(user: models.User = Depends(get_current_user)):
    try:
        url = oauth_tokens.ms_authorize_url(create_oauth_state(user.id, "microsoft"))
    except oauth_tokens.OAuthNotConfigured as e:
        raise HTTPException(503, str(e))
    return {"authorize_url": url}


@router.get("/microsoft/callback")
def microsoft_callback(code: str | None = None, state: str | None = None, error: str | None = None, db: Session = Depends(get_db)):
    if error or not code or not state:
        return RedirectResponse(_frontend_redirect(f"/connect/error?provider=microsoft_excel&reason={error or 'missing_code'}"))

    user_id = decode_oauth_state(state, "microsoft")
    if not user_id:
        return RedirectResponse(_frontend_redirect("/connect/error?provider=microsoft_excel&reason=bad_state"))

    try:
        tokens = oauth_tokens.ms_exchange_code(code)
    except (oauth_tokens.OAuthError, oauth_tokens.OAuthNotConfigured) as e:
        print(f"[connections] Microsoft token exchange failed: {e}")
        return RedirectResponse(_frontend_redirect("/connect/error?provider=microsoft_excel&reason=token_exchange"))

    ds = models.DataSource(
        owner_id=user_id,
        name=_PENDING_NAME["microsoft_excel"],
        kind="microsoft_excel",
        connection_info={"pending": True},
        encrypted_secret=oauth_tokens.encode_token_blob(tokens),
        read_only=True,
        schema_cache={},
    )
    db.add(ds)
    db.commit()
    db.refresh(ds)
    return RedirectResponse(_frontend_redirect(f"/connect/microsoft_excel?connection_id={ds.id}"))


# ---------------------------------------------------------------------------
# Shared: list this pending connection's resources, list every pending
# connection, pick one to finish, and pick one to load a live preview.
# ---------------------------------------------------------------------------

@router.get("/pending", response_model=list[schemas.DataSourceOut])
def list_pending(db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    """Every OAuth connection this person has started but never finished
    picking a spreadsheet/workbook for - hidden from the normal data-source
    list (see datasources.list_datasources) but still a real row taking up
    space, so this is how the frontend's picker page recovers if the
    person refreshes mid-flow, and how a stray one can be found again to
    delete via the ordinary DELETE /datasources/{id}."""
    rows = db.query(models.DataSource).filter(
        models.DataSource.owner_id == user.id,
        models.DataSource.kind.in_(["google_sheets", "microsoft_excel"]),
    ).all()
    return [ds for ds in rows if (ds.connection_info or {}).get("pending")]


@router.get("/{connection_id}/resources", response_model=schemas.OAuthResourcesOut)
def list_resources(connection_id: str, search: str | None = None, db: Session = Depends(get_db), user: models.User = Depends(get_current_user)):
    ds = db.query(models.DataSource).filter(
        models.DataSource.id == connection_id, models.DataSource.owner_id == user.id,
    ).first()
    if not ds or ds.kind not in ("google_sheets", "microsoft_excel"):
        raise HTTPException(404, "Connection not found.")

    try:
        access_token = oauth_tokens.get_valid_access_token(ds, db=db)
        if ds.kind == "google_sheets":
            resources = oauth_tokens.list_google_spreadsheets(access_token, search=search)
        else:
            resources = oauth_tokens.list_ms_workbooks(access_token, search=(search or ".xlsx"))
    except oauth_tokens.OAuthError as e:
        raise HTTPException(400, str(e))

    return {"provider": ds.kind, "resources": resources}


@router.post("/{connection_id}/finish", response_model=schemas.DataSourceOut, status_code=201)
def finish_connection(
    connection_id: str,
    payload: schemas.OAuthFinishRequest,
    db: Session = Depends(get_db),
    user: models.User = Depends(get_current_user),
):
    """Picks a specific spreadsheet/workbook and turns a pending OAuth
    connection into a genuine, usable data source - tests the connection
    and introspects its schema exactly like connect_database/connect_
    warehouse in routers/datasources.py do, so a broken share/permission
    issue is caught right here instead of surfacing later as a confusing
    error on the Data tab."""
    ds = db.query(models.DataSource).filter(
        models.DataSource.id == connection_id, models.DataSource.owner_id == user.id,
    ).first()
    if not ds or ds.kind not in ("google_sheets", "microsoft_excel"):
        raise HTTPException(404, "Connection not found.")
    if not (ds.connection_info or {}).get("pending"):
        raise HTTPException(400, "This connection has already been finished.")

    try:
        access_token = oauth_tokens.get_valid_access_token(ds, db=db)
        if ds.kind == "google_sheets":
            connector = GoogleSheetsConnector(access_token, payload.resource_id)
        else:
            connector = MicrosoftExcelConnector(access_token, payload.resource_id, payload.drive_id)
        connector.test_connection()
        schema = connector.introspect_schema()
    except (oauth_tokens.OAuthError, ValueError) as e:
        raise HTTPException(400, f"Could not connect: {e}")

    if ds.kind == "google_sheets":
        ds.connection_info = {"spreadsheet_id": payload.resource_id, "spreadsheet_name": payload.resource_name}
    else:
        ds.connection_info = {
            "item_id": payload.resource_id, "drive_id": payload.drive_id, "file_name": payload.resource_name,
        }
    ds.name = payload.name.strip()[:120] or payload.resource_name
    ds.schema_cache = schema
    db.commit()
    db.refresh(ds)
    return ds
