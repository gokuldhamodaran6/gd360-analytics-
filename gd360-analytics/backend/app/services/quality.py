"""2026-10-17 (R52): the nightly quality check - the 12-question set (plus 4 on two more datasets) asked of the LIVE
model, every night, with each answer checked and timed against its budget.

It runs inside the app, as a dedicated account ("GD360 nightly checks", no password anyone can use), on three
datasets it generates itself so the check never depends on a customer's data:
  credit card customers (10,127 rows, the BankChurners schema), hotel bookings (dated), barista sales (dated).
Each question goes through exactly the path a person's question takes (turns.new_conversation / turns.send), so a
pass means the product answered, not a test double. Results land in quality_runs; Mission Control > Quality shows
them, and "Run now" starts one by hand. The schedule (02:10 UTC) is on unless an admin switches it off
(admin_settings key "quality.nightly").

What it can't do: take screenshots. The answers, chips, cards and timings are checked; the look is checked by the
browser suites in the repo (e2e/r48_ui ... r52_ui) against the mockup boards.
"""
from __future__ import annotations

import asyncio
import io
import secrets
import threading
import time
import traceback
from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from .. import models
from ..database import SessionLocal
from . import ai_meter

EVAL_EMAIL = "nightly-checks@gd360.internal"
EVAL_NAME = "Euliv nightly checks"
SETTING = "quality.nightly"
_lock = threading.Lock()


# ---- the datasets ---------------------------------------------------------------------------------

def credit_card_csv() -> bytes:
    """The BankChurners schema: 10,127 customers, ~16% attrition, usage drives it, two Naive_Bayes columns leak it."""
    rng = np.random.default_rng(48)
    n = 10127
    age = np.clip(rng.normal(46, 8, n).round(), 26, 73).astype(int)
    gender = rng.choice(["F", "M"], n, p=[0.529, 0.471])
    dependents = rng.integers(0, 6, n)
    education = rng.choice(["High School", "Graduate", "Uneducated", "Unknown", "College", "Post-Graduate", "Doctorate"], n,
                           p=[0.20, 0.31, 0.15, 0.15, 0.10, 0.05, 0.04])
    marital = rng.choice(["Married", "Single", "Unknown", "Divorced"], n, p=[0.46, 0.39, 0.07, 0.08])
    income = rng.choice(["Less than $40K", "$40K - $60K", "$60K - $80K", "$80K - $120K", "$120K +", "Unknown"], n,
                        p=[0.35, 0.18, 0.14, 0.15, 0.07, 0.11])
    card = rng.choice(["Blue", "Silver", "Gold", "Platinum"], n, p=[0.932, 0.055, 0.011, 0.002])
    months_on_book = np.clip(rng.normal(36, 8, n).round(), 13, 56).astype(int)
    relationship = rng.integers(1, 7, n)
    inactive = rng.choice([0, 1, 2, 3, 4, 5, 6], n, p=[0.003, 0.22, 0.32, 0.38, 0.043, 0.018, 0.016])
    contacts = rng.choice([0, 1, 2, 3, 4, 5, 6], n, p=[0.04, 0.15, 0.32, 0.33, 0.14, 0.017, 0.003])
    credit_limit = np.round(np.exp(rng.normal(8.6, 0.9, n)), 1).clip(1400, 34516)
    z = (rng.normal(0, 1, n) - 0.35 * (relationship - 3.5) + 0.25 * (inactive - 2.3) + 0.25 * (contacts - 2.4)
         + 0.08 * (income == "Less than $40K") + 0.12 * (card == "Platinum") + 0.05 * (gender == "F"))
    churn = rng.random(n) < 1 / (1 + np.exp(-(z - 2.08)))
    trans_ct = np.clip(rng.normal(np.where(churn, 45, 69), np.where(churn, 14, 22)), 10, 139).round().astype(int)
    trans_amt = np.clip(trans_ct * rng.normal(np.where(churn, 68, 67), 25, n) + rng.normal(0, 300, n), 510, 18484).round(0)
    ct_chng = np.clip(rng.normal(np.where(churn, 0.55, 0.74), 0.2, n), 0, 3.7).round(3)
    amt_chng = np.clip(rng.normal(np.where(churn, 0.69, 0.78), 0.2, n), 0, 3.4).round(3)
    revolving = np.where(rng.random(n) < np.where(churn, 0.42, 0.21), 0, rng.integers(300, 2517, n))
    open_to_buy = np.clip(credit_limit - revolving, 3, None).round(1)
    util = np.where(credit_limit > 0, revolving / credit_limit, 0).round(3)
    clientnum = rng.choice(np.arange(708082083, 828343083), n, replace=False)
    nb1 = np.where(churn, rng.uniform(0.6, 0.99, n), rng.uniform(0.0001, 0.3, n)).round(5)
    nb = "Naive_Bayes_Classifier_Attrition_Flag_Card_Category_Contacts_Count_12_mon_Dependent_count_Education_Level_Months_Inactive_12_mon_"
    df = pd.DataFrame({
        "CLIENTNUM": clientnum, "Attrition_Flag": np.where(churn, "Attrited Customer", "Existing Customer"),
        "Customer_Age": age, "Gender": gender, "Dependent_count": dependents, "Education_Level": education,
        "Marital_Status": marital, "Income_Category": income, "Card_Category": card, "Months_on_book": months_on_book,
        "Total_Relationship_Count": relationship, "Months_Inactive_12_mon": inactive, "Contacts_Count_12_mon": contacts,
        "Credit_Limit": credit_limit, "Total_Revolving_Bal": revolving, "Avg_Open_To_Buy": open_to_buy,
        "Total_Amt_Chng_Q4_Q1": amt_chng, "Total_Trans_Amt": trans_amt, "Total_Trans_Ct": trans_ct,
        "Total_Ct_Chng_Q4_Q1": ct_chng, "Avg_Utilization_Ratio": util, nb + "1": nb1, nb + "2": (1 - nb1).round(5),
    })
    return df.to_csv(index=False).encode()


def hotel_csv() -> bytes:
    """6,000 bookings over two years: lead time, deposit and segment drive cancellations."""
    rng = np.random.default_rng(52)
    n = 6000
    arrival = pd.to_datetime("2024-01-01") + pd.to_timedelta(rng.integers(0, 730, n), unit="D")
    hotel = rng.choice(["City Hotel", "Resort Hotel"], n, p=[0.62, 0.38])
    segment = rng.choice(["Online TA", "Offline TA/TO", "Direct", "Groups", "Corporate"], n, p=[0.47, 0.2, 0.11, 0.17, 0.05])
    deposit = rng.choice(["No Deposit", "Non Refund", "Refundable"], n, p=[0.86, 0.12, 0.02])
    lead = np.clip(rng.gamma(1.6, 60, n), 0, 600).round().astype(int)
    nights = np.clip(rng.poisson(3, n), 1, 21)
    month_factor = 1 + 0.35 * np.sin((arrival.month.values - 4) / 12 * 2 * np.pi)
    adr = np.round(np.clip(rng.normal(np.where(hotel == "City Hotel", 105, 95), 30, n) * month_factor, 25, 450), 2)
    special = rng.choice([0, 1, 2, 3], n, p=[0.58, 0.28, 0.11, 0.03])
    z = (rng.normal(0, 1, n) + 0.006 * lead + 1.6 * (deposit == "Non Refund") + 0.5 * (segment == "Groups") - 0.45 * special
         - 0.6 * (segment == "Direct") + 0.2 * (hotel == "City Hotel"))
    canceled = rng.random(n) < 1 / (1 + np.exp(-(z - 1.4)))
    df = pd.DataFrame({
        "booking_id": np.arange(100001, 100001 + n), "hotel": hotel, "arrival_date": arrival.strftime("%Y-%m-%d"),
        "lead_time": lead, "stays_nights": nights, "market_segment": segment, "deposit_type": deposit, "adr": adr,
        "total_of_special_requests": special, "revenue": np.where(canceled, 0, np.round(adr * nights, 2)),
        "is_canceled": canceled.astype(int),
    }).sort_values("arrival_date")
    return df.to_csv(index=False).encode()


def barista_csv() -> bytes:
    """Daily sales by store, category and channel for a year."""
    rng = np.random.default_rng(7)
    days = pd.date_range("2025-10-01", "2026-09-30", freq="D")
    rows = []
    base = {"Coffee": 90, "Tea": 35, "Pastry": 50, "Sandwich": 28, "Merch": 6}
    price = {"Coffee": 4.2, "Tea": 3.6, "Pastry": 3.9, "Sandwich": 7.5, "Merch": 18.0}
    for d in days:
        season = 1 + 0.18 * np.cos((d.month - 1) / 12 * 2 * np.pi) + (0.12 if d.weekday() >= 5 else 0)
        for store, sf in (("Downtown", 1.25), ("Harbor", 0.9), ("Campus", 1.0)):
            for cat, b in base.items():
                for ch, cf in (("In store", 0.7), ("App", 0.3)):
                    u = max(0, int(rng.normal(b * sf * season * cf, b * 0.08)))
                    disc = round(u * price[cat] * rng.uniform(0.0, 0.08), 2)
                    rows.append((d.strftime("%Y-%m-%d"), store, cat, ch, u, round(u * price[cat] - disc, 2), disc))
    df = pd.DataFrame(rows, columns=["order_date", "store", "product_category", "channel", "units", "revenue", "discount"])
    return df.to_csv(index=False).encode()


DATASETS = {
    "cards": ("Nightly check · credit card customers", "BankChurners.csv", credit_card_csv),
    "hotel": ("Nightly check · hotel bookings", "hotel_bookings.csv", hotel_csv),
    "barista": ("Nightly check · barista sales", "barista_sales.csv", barista_csv),
}


# ---- the questions --------------------------------------------------------------------------------

def _chip(t: dict, key: str) -> dict | None:
    return next((c for c in t.get("chips") or [] if c.get("key") == key), None)


def _txt(t: dict) -> str:
    return (t.get("text") or "").lower()


# (n, dataset, question, expected kind, [(label, check(turn) -> bool)])
QUESTIONS: list[tuple[str, str, str, str, list]] = [
    ("01", "cards", "Analyze customer data to identify the main reasons for churn, predict which customers are likely to leave, and recommend ways to retain them", "analysis", [
        ("finds Attrition_Flag as the outcome", lambda t: ((t.get("analysis") or {}).get("target") or {}).get("column") == "Attrition_Flag"),
        ("reads all 10,127 rows", lambda t: ((t.get("analysis") or {}).get("baseline") or {}).get("n") == 10127),
        ("model tested on held-out rows", lambda t: bool(_chip(t, "validation"))),
        ("leaking columns removed", lambda t: bool(_chip(t, "leaks"))),
        ("three risk tiers", lambda t: len((t.get("analysis") or {}).get("tiers") or []) == 3),
        ("recommendations with reach", lambda t: len((t.get("analysis") or {}).get("recommendations") or []) >= 2),
        ("every number in the text is in the findings", lambda t: bool(_chip(t, "numbers")) or bool(_chip(t, "rewritten"))),
    ]),
    ("02", "cards", "Which card category loses the most customers?", "analysis", [
        ("split by card category", lambda t: ((t.get("analysis") or {}).get("by_dimension") or {}).get("column") == "Card_Category"),
        ("finding first, not a count", lambda t: not _txt(t).startswith("out of")),
    ]),
    ("03", "cards", "Does inactivity predict attrition?", "analysis", [
        ("focus on months inactive", lambda t: "inactive" in (((t.get("analysis") or {}).get("focus") or {}).get("column") or "").lower()),
    ]),
    ("04", "cards", "build a dashbaord with a page per segment", "dashboard", [
        ("the typo is understood", lambda t: t.get("kind") == "dashboard"),
        ("three or more pages", lambda t: len((t.get("built") or {}).get("pages") or []) >= 3),
        ("live chip", lambda t: bool(_chip(t, "live"))),
    ]),
    ("05", "cards", "make it navy and call it Retention pulse", "dashboard_edit", [
        ("renamed", lambda t: ((t.get("edit") or {}).get("after") or {}).get("name") == "Retention pulse"),
        ("navy theme", lambda t: ((t.get("edit") or {}).get("after") or {}).get("theme") == "navy"),
    ]),
    ("06", "cards", "Alert me if churn in any segment passes 25%", "automation", [
        ("a confirm card, nothing set up yet", lambda t: t.get("status") == "confirm" and bool(t.get("confirm"))),
        ("watches the segments", lambda t: "segment" in _txt(t)),
    ]),
    ("07", "cards", "Write a one-page retention brief for the board", "document", [
        ("one page", lambda t: ((t.get("artifacts") or [{}])[0]).get("pages") == 1),
        ("has a figure", lambda t: (((t.get("artifacts") or [{}])[0]).get("figures") or 0) >= 1),
        ("every figure re-checked", lambda t: bool((_chip(t, "numbers") or {}).get("ok"))),
    ]),
    ("08", "cards", "who is the chief minister of Tamil Nadu?", "knowledge", [
        ("numbered sources", lambda t: len(t.get("sources") or []) >= 1 and all(s.get("title") for s in t.get("sources") or [])),
        ("citations in the text", lambda t: "[1]" in (t.get("text") or "")),
    ]),
    ("09", "cards", "who is ttf vasan", "knowledge", [
        ("does not re-answer the chief minister", lambda t: "chief minister of tamil nadu" not in _txt(t)),
        ("answers", lambda t: len(_txt(t)) > 40),
    ]),
    ("10", "cards", "show the high-risk customers as a list", "list", [
        ("the high tier, every row", lambda t: (t.get("list") or {}).get("total", 0) > 0 and (t.get("list") or {}).get("shown") == (t.get("list") or {}).get("total")),
        ("customer ids and scores", lambda t: bool((t.get("list") or {}).get("rows")) and "score" in (t.get("list") or {}).get("rows")[0]),
    ]),
    ("11", "cards", "what if churn fell by a quarter in the low-usage band?", "whatif", [
        ("assumptions stated", lambda t: len((t.get("whatif") or {}).get("assumptions") or []) >= 3),
        ("a lower overall rate", lambda t: ((t.get("whatif") or {}).get("after") or {}).get("overall_rate", 99) < ((t.get("whatif") or {}).get("before") or {}).get("overall_rate", 0)),
    ]),
    ("12", "cards", "Share this with the Retention team without customer IDs", "team", [
        ("a confirm card", lambda t: t.get("status") == "confirm"),
        ("hides CLIENTNUM", lambda t: any(h.get("column") == "CLIENTNUM" for h in ((t.get("confirm") or {}).get("hidden") or []))),
    ]),
    ("13", "hotel", "Why do bookings get cancelled, and which upcoming bookings are likely to cancel?", "analysis", [
        ("finds is_canceled as the outcome", lambda t: ((t.get("analysis") or {}).get("target") or {}).get("column") == "is_canceled"),
        ("model tested on held-out rows", lambda t: bool(_chip(t, "validation"))),
    ]),
    ("14", "hotel", "Which month had the lowest revenue?", "data", [
        ("answered", lambda t: t.get("status") == "done"),
    ]),
    ("15", "barista", "Which product category made the most revenue, and how did it trend by month?", "data", [
        ("answered", lambda t: t.get("status") == "done"),
    ]),
    ("16", "barista", "build a dashboard of our sales", "dashboard", [
        ("a designed board", lambda t: bool((t.get("artifacts") or [{}])[0].get("board"))),
    ]),
]


# ---- running ------------------------------------------------------------------------------------

def _eval_user(db) -> models.User:
    from ..security import hash_password
    u = db.query(models.User).filter(models.User.email == EVAL_EMAIL).first()
    if u is None:
        u = models.User(email=EVAL_EMAIL, hashed_password=hash_password(secrets.token_urlsafe(32)), full_name=EVAL_NAME)
        if hasattr(u, "email_verified_at"):
            u.email_verified_at = datetime.utcnow()
        db.add(u)
        db.commit()
        db.refresh(u)
    return u


def _source(db, user: models.User, key: str) -> str:
    name, filename, make = DATASETS[key]
    ds = db.query(models.DataSource).filter(models.DataSource.owner_id == user.id, models.DataSource.name == name).first()
    if ds is not None:
        return ds.id
    from starlette.datastructures import UploadFile
    from ..routers import datasources
    up = UploadFile(file=io.BytesIO(make()), filename=filename)
    out = asyncio.run(datasources.upload_file(name=name, file=up, db=db, user=user))
    return out.id if hasattr(out, "id") else out["id"]


def _reload(db, conv: models.Conversation, user: models.User, turn_id: str) -> dict:
    from .agent import turns
    db.expire_all()
    msg = db.get(models.Message, turn_id)
    if msg is not None:
        return turns._message_turn(db, msg, conv, user)
    run = db.get(models.ProjectRun, turn_id)
    if run is not None:
        return turns._run_turn(db, run, conv, user, full=False)
    return {"id": turn_id, "status": "failed", "error": "turn vanished"}


def _wait(db, conv, user, t: dict, kind_hint: str) -> tuple[dict, float]:
    from .agent import budgets
    t0 = time.time()
    limit = (budgets.hard(t.get("kind") or kind_hint) or 300) + 60
    while t.get("status") in ("working", "steps") and time.time() - t0 < limit:
        time.sleep(1.5)
        t = _reload(db, conv, user, t["id"])
    return t, time.time() - t0


def _ask(db, user, convs: dict, key: str, sid: str, q: str, kind: str) -> tuple[dict, float]:
    from .agent import turns
    t0 = time.time()
    conv = convs.get(key)
    if conv is None:
        conv = turns.new_conversation(db, user, question=q, space_id=None, source_ids=[sid], workspace_id=None)
        convs[key] = conv
    t = turns.send(db, conv, user, q, today=date.today())
    t, _ = _wait(db, conv, user, t, kind)
    return t, time.time() - t0


def _seconds_of(t: dict, wall: float) -> float:
    # the turn's own clock when it has one (a data run's duration), else the wall clock around it
    e = t.get("elapsed_s")
    return round(float(e) if isinstance(e, (int, float)) and e > 0 and abs(e - wall) < 30 else wall, 1)


def run_checks(run_id: str) -> None:
    from .agent import budgets, turns
    db = SessionLocal()
    run = db.get(models.QualityRun, run_id)
    user = _eval_user(db)
    token = ai_meter.set_context(user.id, "Nightly checks")
    started = datetime.utcnow()
    results: list[dict] = []
    try:
        sids = {k: _source(db, user, k) for k in DATASETS}
        convs: dict = {}
        for n, key, q, kind, checks in QUESTIONS:
            item = {"n": n, "dataset": key, "question": q, "expected": kind}
            try:
                t, wall = _ask(db, user, convs, key, sids[key], q, kind)
                secs = _seconds_of(t, wall)
                got = []
                for label, fn in checks:
                    try:
                        ok = bool(fn(t))
                    except Exception:  # noqa: BLE001 - a check that can't read the turn is a failed check
                        ok = False
                    got.append({"label": label, "ok": ok})
                route_ok = t.get("kind") == kind
                status_ok = t.get("status") in ("done", "confirm")
                budget = budgets.budget(kind)
                item |= {"kind": t.get("kind"), "status": t.get("status"), "seconds": secs, "budget": budget,
                         "over": bool(budget and secs > budget), "checks": [{"label": f"routed to {kind}", "ok": route_ok},
                                                                            {"label": "finished", "ok": status_ok}] + got,
                         "text": (t.get("text") or t.get("error") or "")[:600], "chips": [c.get("label") for c in t.get("chips") or []][:6],
                         "sources": [s.get("domain") or s.get("url") for s in t.get("sources") or []][:5],
                         "conversation_id": convs[key].id, "turn_id": t.get("id")}
                item["passed"] = all(c["ok"] for c in item["checks"])
                if kind in ("automation", "team") and t.get("status") == "confirm":
                    turns.confirm(db, convs[key], user, t["id"], approve=False)  # never set anything up
            except Exception as e:  # noqa: BLE001 - one question never stops the night
                traceback.print_exc()
                db.rollback()
                item |= {"passed": False, "status": "error", "error": str(e)[:300], "checks": [{"label": "ran", "ok": False}]}
            results.append(item)
            run.results = list(results)
            run.summary = _summary(results)
            db.commit()
        run.status = "done"
    except Exception as e:  # noqa: BLE001
        traceback.print_exc()
        db.rollback()
        run = db.get(models.QualityRun, run_id)
        run.status, run.error = "failed", str(e)[:500]
    finally:
        run.finished_at = datetime.utcnow()
        run.results = results
        run.summary = _summary(results) | {"cost_usd": _cost(db, user.id, started)}
        db.commit()
        ai_meter.reset_context(token)
        _cleanup(db, user)
        db.close()


def _summary(results: list[dict]) -> dict:
    passed = sum(1 for r in results if r.get("passed"))
    over = sum(1 for r in results if r.get("over"))
    by_kind: dict[str, list[float]] = {}
    for r in results:
        if r.get("seconds") is not None:
            by_kind.setdefault(r["expected"], []).append(r["seconds"])
    return {"total": len(results), "passed": passed, "failed": len(results) - passed, "over_budget": over, "of": len(QUESTIONS),
            "slowest": max((r for r in results if r.get("seconds") is not None), key=lambda r: r["seconds"], default={}).get("n"),
            "seconds_by_kind": {k: round(max(v), 1) for k, v in by_kind.items()}}


def _cost(db, user_id: str, since: datetime) -> float | None:
    from sqlalchemy import func
    try:
        v = db.query(func.coalesce(func.sum(models.AICall.cost_usd), 0)).filter(models.AICall.user_id == user_id, models.AICall.created_at >= since).scalar()
        return round(float(v or 0), 4)
    except Exception:  # noqa: BLE001
        db.rollback()
        return None


def _cleanup(db, user: models.User, keep_days: int = 14) -> None:
    """The check's own conversations and dashboards older than two weeks go; the datasets stay."""
    try:
        cut = datetime.utcnow() - timedelta(days=keep_days)
        old = db.query(models.Conversation).filter(models.Conversation.owner_id == user.id, models.Conversation.created_at < cut).all()
        for c in old:
            db.query(models.ProjectRun).filter(models.ProjectRun.conversation_id == c.id).delete(synchronize_session=False)
            db.query(models.Dashboard).filter(models.Dashboard.source_conversation_id == c.id).update({models.Dashboard.source_conversation_id: None}, synchronize_session=False)
            db.delete(c)
        db.query(models.Dashboard).filter(models.Dashboard.owner_id == user.id, models.Dashboard.created_at < cut).delete(synchronize_session=False)
        db.commit()
    except Exception as e:  # noqa: BLE001 - tidying never fails a run
        print(f"[quality] cleanup skipped: {e}")
        db.rollback()


def start(trigger: str, started_by: str | None = None) -> models.QualityRun | None:
    """Starts a run in the background unless one is already running. Returns the run, or None if one is running."""
    with _lock:
        db = SessionLocal()
        try:
            busy = db.query(models.QualityRun).filter(models.QualityRun.status == "running",
                                                      models.QualityRun.started_at > datetime.utcnow() - timedelta(hours=2)).first()
            if busy is not None:
                return None
            from ..config import get_settings
            s = get_settings()
            run = models.QualityRun(trigger=trigger, started_by=started_by, status="running", provider=s.AI_PROVIDER,
                                    model=ai_meter.model_name(s.AI_PROVIDER, None), results=[], summary={"total": 0, "of": len(QUESTIONS)})
            db.add(run)
            db.commit()
            db.refresh(run)
            db.expunge(run)
        finally:
            db.close()
    threading.Thread(target=run_checks, args=(run.id,), daemon=True, name=f"quality-{run.id[:8]}").start()
    return run


def nightly_enabled(db) -> bool:
    row = db.get(models.AdminSetting, SETTING)
    v = row.value if row is not None else None
    return not (isinstance(v, dict) and v.get("on") is False)


def nightly_tick() -> None:
    """The scheduler's 02:10 UTC job: one run a night, skipped when switched off or when one ran in the last 20 hours."""
    db = SessionLocal()
    try:
        if not nightly_enabled(db):
            return
        recent = db.query(models.QualityRun).filter(models.QualityRun.trigger == "nightly",
                                                    models.QualityRun.started_at > datetime.utcnow() - timedelta(hours=20)).first()
        if recent is not None:
            return
    finally:
        db.close()
    start("nightly")
