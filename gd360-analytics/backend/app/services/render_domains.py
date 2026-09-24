"""
Thin wrapper around Render's Custom Domains REST API (api.render.com/v1) -
used by Dashboard Builder Phase 4 (2026-09-24, white-label custom domains)
to let a dashboard owner point their own subdomain (e.g.
dashboards.theircompany.com) at their published dashboard.

Requires two settings that are NOT set by default and must be configured
by whoever runs this app - see config.py's own comments for exactly how
to obtain each one:
  - RENDER_API_KEY: a Render account API key with permission to manage
    this account's services.
  - RENDER_FRONTEND_SERVICE_ID: the Render service id of the FRONTEND
    static site every custom domain gets pointed at (the same static
    site that already serves this app's own onrender.com URL) - every
    custom domain, across every dashboard on this whole installation, is
    registered against this ONE service, since Render serves the exact
    same built JS bundle regardless of which hostname it was reached
    through. The frontend itself (see api/client.ts's publicDashboardApi.
    getByHostname and pages/PublicDashboardView.tsx) is what looks at
    window.location.hostname at runtime and resolves it, through this
    backend, to the right dashboard.

Deliberately calls Render's public REST API directly with `requests`
(the same library ai_engine.py/oauth_tokens.py/connectors.py already use
for every other outbound HTTP call in this app) rather than going through
the Render MCP connector available in a Claude session - that connector
is for an interactive Claude session, not this app's own always-on
production backend, and as of this writing it has no tool exposed for
managing custom domains anyway.

Honest limitation worth stating plainly: this module's exact handling of
Render's verification/SSL response fields (_status_from_domain_payload
below) was written from Render's published API reference and docs, not
verified against a live call - this session's own sandboxed environment
has neither a Render API key configured nor a real custom domain to test
against. It is written defensively (reads several possible field-name
variants, and only ever reports "live" when it's confident, never
optimistically), so the worst case if Render's actual response shape
differs is that a real, working domain sits at "pending_ssl" a little
longer than it needed to - never a false "live" shown before visitors
can actually reach it. If Gokul reports a domain stuck in that state
after Render's own dashboard shows it as active, a future session should
add a print() of the raw response here and adjust the field matching.
"""
import requests

from ..config import get_settings

settings = get_settings()

_API_BASE = "https://api.render.com/v1"
_TIMEOUT = 15


class RenderDomainsNotConfigured(Exception):
    """RENDER_API_KEY or RENDER_FRONTEND_SERVICE_ID isn't set yet - see
    this module's own docstring and config.py for how to set them up."""


class RenderDomainError(Exception):
    """Render's API rejected the request (malformed domain, already
    claimed by a different Render service, this account's plan doesn't
    allow another custom domain, etc). str(e) is a message safe to show
    the dashboard owner directly - it either comes straight from Render's
    own error response or is a plain description of an unexpected one."""


def _headers() -> dict:
    if not settings.RENDER_API_KEY or not settings.RENDER_FRONTEND_SERVICE_ID:
        raise RenderDomainsNotConfigured(
            "Custom domains aren't set up on this installation yet - RENDER_API_KEY and "
            "RENDER_FRONTEND_SERVICE_ID need to be set as backend environment variables first."
        )
    return {"Authorization": f"Bearer {settings.RENDER_API_KEY}", "Accept": "application/json"}


def _error_detail(resp: "requests.Response") -> str:
    try:
        body = resp.json()
        msg = body.get("message") or body.get("error") or str(body)
    except ValueError:
        msg = resp.text or f"Render API returned {resp.status_code}."
    return msg


def _status_from_domain_payload(payload: dict) -> str:
    """Render's own verification/SSL fields collapsed into this app's own
    three-state status: "pending_dns" (Render hasn't verified the DNS
    record yet), "pending_ssl" (DNS verified, certificate still being
    issued), or "live" (verified AND a certificate is issued - Render is
    actually serving HTTPS traffic for this domain now). Read
    defensively - see this module's own docstring for why."""
    domain = payload.get("domain") if isinstance(payload.get("domain"), dict) else payload
    verification = str(domain.get("verificationStatus") or domain.get("verification_status") or "").lower()
    ssl_status = str(
        domain.get("sslStatus") or domain.get("ssl_status")
        or domain.get("certificateStatus") or domain.get("certificate_status") or ""
    ).lower()

    verified = verification in ("verified", "verified_manually", "success", "active")
    if not verified:
        return "pending_dns"

    issued = ssl_status in ("issued", "active", "valid", "success")
    if issued:
        return "live"
    # Verified but no SSL field, or an SSL field that isn't clearly
    # "issued" yet (e.g. "pending", "issuing", "provisioning") - keep
    # this as still-provisioning rather than guessing "live".
    return "pending_ssl"


def create_custom_domain(domain: str) -> tuple[str, str]:
    """Registers `domain` against this installation's frontend static
    site on Render. Render itself then does two things automatically,
    with no further action needed from this backend: (1) checks the DNS
    record the dashboard owner was told to add (a CNAME pointing
    `domain` at this app's own onrender.com hostname) and marks the
    domain verified once it finds it - this can take anywhere from a few
    minutes to a few hours depending on the owner's DNS provider and how
    quickly the record propagates; (2) once verified, issues a free TLS
    certificate (Let's Encrypt or Google Trust Services) for `domain`,
    after which Render starts actually serving HTTPS traffic for it.
    Returns (render_custom_domain_id, initial_status) - the id is stored
    on the DashboardShare so a later status check or delete can reference
    this exact domain registration."""
    resp = requests.post(
        f"{_API_BASE}/services/{settings.RENDER_FRONTEND_SERVICE_ID}/custom-domains",
        headers=_headers(),
        json={"name": domain},
        timeout=_TIMEOUT,
    )
    if resp.status_code == 201:
        payload = resp.json()
        domain_obj = payload.get("domain") if isinstance(payload.get("domain"), dict) else payload
        domain_id = domain_obj.get("id") or domain_obj.get("name") or domain
        return domain_id, _status_from_domain_payload(payload)
    raise RenderDomainError(_error_detail(resp))


def get_custom_domain_status(render_domain_id: str) -> str:
    """Re-checks a previously-registered domain's current verification/
    SSL state with Render - called by the dashboard owner's "Check
    again" button, since Render does the actual DNS check and
    certificate issuance in the background on its own schedule, not
    synchronously in response to create_custom_domain above."""
    resp = requests.get(
        f"{_API_BASE}/services/{settings.RENDER_FRONTEND_SERVICE_ID}/custom-domains/{render_domain_id}",
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    if resp.status_code == 200:
        return _status_from_domain_payload(resp.json())
    if resp.status_code == 404:
        raise RenderDomainError(
            "This domain is no longer registered on Render - it may have been removed manually. "
            "Try adding it again."
        )
    raise RenderDomainError(_error_detail(resp))


def delete_custom_domain(render_domain_id: str) -> None:
    """Best-effort deregistration - the caller (remove_custom_domain in
    routers/dashboard_builder.py) still clears this app's own local
    state even if this raises, so a dashboard owner is never stuck
    unable to remove a domain locally just because Render's side of it
    already changed underneath them (e.g. someone removed it by hand in
    the Render dashboard)."""
    resp = requests.delete(
        f"{_API_BASE}/services/{settings.RENDER_FRONTEND_SERVICE_ID}/custom-domains/{render_domain_id}",
        headers=_headers(),
        timeout=_TIMEOUT,
    )
    if resp.status_code not in (200, 204, 404):
        raise RenderDomainError(_error_detail(resp))
