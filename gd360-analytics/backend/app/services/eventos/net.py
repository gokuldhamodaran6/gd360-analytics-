"""Fetching a public web page or image someone pasted, safely: http(s)
only, no private / internal addresses (checked on every redirect), a size
cap and a short timeout."""
from __future__ import annotations

import base64
import ipaddress
import re
import socket
from urllib.parse import urljoin, urlparse

import requests

UA = "Mozilla/5.0 (compatible; Euliv-EventOS/1.0; +https://gd360.ai)"


class FetchError(Exception):
    pass


def _public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast or ip.is_unspecified:
            return False
    return True


def safe_get(url: str, max_bytes: int = 2_000_000, timeout: float = 8.0, accept: str = "*/*") -> tuple[bytes, str, str]:
    """-> (body, content_type, final_url)"""
    if url.startswith("data:"):
        m = re.match(r"data:([^;,]+)?(;base64)?,(.*)", url, re.S)
        if not m:
            raise FetchError("Unreadable data URL.")
        raw = base64.b64decode(m.group(3)) if m.group(2) else m.group(3).encode()
        return raw[:max_bytes], m.group(1) or "application/octet-stream", url
    for _ in range(4):
        p = urlparse(url)
        if p.scheme not in ("http", "https") or not p.hostname:
            raise FetchError("Only http and https links can be read.")
        if not _public_host(p.hostname):
            raise FetchError("That address isn't a public website.")
        r = requests.get(url, headers={"User-Agent": UA, "Accept": accept}, timeout=timeout, stream=True,
                         allow_redirects=False)
        if r.status_code in (301, 302, 303, 307, 308) and r.headers.get("location"):
            url = urljoin(url, r.headers["location"])
            r.close()
            continue
        if r.status_code >= 400:
            r.close()
            raise FetchError(f"The site answered {r.status_code}.")
        chunks, size = [], 0
        for ch in r.iter_content(64 * 1024):
            chunks.append(ch)
            size += len(ch)
            if size > max_bytes:
                break
        r.close()
        return b"".join(chunks)[:max_bytes], (r.headers.get("content-type") or "").split(";")[0].strip(), url
    raise FetchError("Too many redirects.")


def page_preview(url: str) -> dict:
    """Title, description, image and site name from a page's Open Graph /
    meta tags."""
    body, ctype, final = safe_get(url, max_bytes=1_500_000, accept="text/html,*/*")
    if ctype.startswith("image/"):
        return {"url": final, "image": final, "title": None, "description": None, "site": urlparse(final).hostname}
    html = body.decode("utf-8", errors="ignore")

    def meta(*names):
        for n in names:
            m = re.search(r'<meta[^>]+(?:property|name)=["\']' + re.escape(n) + r'["\'][^>]*content=["\']([^"\']+)', html, re.I) \
                or re.search(r'<meta[^>]+content=["\']([^"\']+)["\'][^>]*(?:property|name)=["\']' + re.escape(n) + r'["\']', html, re.I)
            if m:
                import html as _h
                return _h.unescape(m.group(1)).strip()
        return None
    title = meta("og:title", "twitter:title")
    if not title:
        m = re.search(r"<title[^>]*>(.*?)</title>", html, re.I | re.S)
        title = re.sub(r"\s+", " ", m.group(1)).strip() if m else None
    img = meta("og:image", "og:image:url", "twitter:image")
    return {"url": final, "title": (title or "")[:300] or None, "description": (meta("og:description", "description", "twitter:description") or "")[:2000] or None,
            "image": urljoin(final, img) if img else None, "site": meta("og:site_name") or urlparse(final).hostname,
            "published": meta("article:published_time", "og:updated_time")}
