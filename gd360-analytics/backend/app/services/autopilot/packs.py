"""2026-10-17 (R53): 14 industry packs - who each industry plans initiatives for, the initiatives it runs most, the
channels that carry them and benchmark ranges to start from when a workspace has no history of its own.

Benchmarks are published industry ranges, labelled "benchmark" wherever they are used: they are a starting point,
never presented as the workspace's own numbers. The workspace's own history (services/initiatives/metrics.history)
always wins when there is one.
"""
from __future__ import annotations

# shared benchmark ranges (low, typical, high), with where they come from
BENCHMARKS = {
    "webinar_attendance_pct": {"range": (35, 48, 60), "source": "Livestorm 2026 (47.7% live); ON24 (about 60% live plus on-demand)"},
    "event_no_show_free_pct": {"range": (40, 50, 60), "source": "Free in-person events: 40-60% no-show (industry range)"},
    "event_no_show_paid_pct": {"range": (10, 15, 25), "source": "Paid events: 10-25% no-show (industry range)"},
    "late_registration_pct": {"range": (40, 50, 60), "source": "About half of registrations arrive in the final 7 days (49.6%)"},
    "linkedin_cpl_usd": {"range": (75, 150, 300), "source": "LinkedIn lead-gen ads: $75-$300 cost per lead"},
    "meta_cpl_usd": {"range": (15, 30, 60), "source": "Meta lead ads, B2B: about $15-$60 per lead"},
    "email_open_pct": {"range": (20, 30, 42), "source": "B2B email open rates (Apple privacy inflates opens; clicks are the honest count)"},
    "email_click_pct": {"range": (1.5, 2.8, 5), "source": "B2B email click rates"},
    "cold_reply_pct": {"range": (2, 5, 10), "source": "Cold outreach reply rates"},
    "warm_reply_pct": {"range": (15, 25, 40), "source": "Warm / personal invites from an account owner"},
    "time_to_hire_days": {"range": (30, 44, 60), "source": "Median time to hire, knowledge roles"},
}

PACKS: dict[str, dict] = {
    "saas_b2b": {
        "label": "B2B software (SaaS)", "audiences": ["customers", "prospects", "partners", "investors", "candidates"],
        "initiatives": [("webinar", "Product webinar for Tier A prospects"), ("event", "Customer summit"), ("abm", "ABM push on 50 named accounts"),
                        ("product", "Feature launch"), ("hiring", "Engineering hiring drive")],
        "channels": ["linkedin", "email", "webinar", "g2_reviews", "partners"],
        "focus": ["pipeline_value", "meetings", "accounts_engaged", "registrations"],
        "benchmarks": ["webinar_attendance_pct", "linkedin_cpl_usd", "email_click_pct", "warm_reply_pct"],
    },
    "fintech_banking": {
        "label": "Banking and fintech", "audiences": ["customers", "regulators", "partners", "investors"],
        "initiatives": [("campaign", "Card activation campaign"), ("event", "Partner and investor day"), ("webinar", "Product briefing for advisers")],
        "channels": ["email", "linkedin", "branch", "app_push", "press"],
        "focus": ["registrations", "meetings", "pipeline_value"],
        "benchmarks": ["email_open_pct", "email_click_pct", "event_no_show_free_pct"],
    },
    "ecommerce_d2c": {
        "label": "E-commerce and D2C brands", "audiences": ["customers", "creators", "partners"],
        "initiatives": [("campaign", "Festive sale campaign"), ("product", "New collection launch"), ("event", "Pop-up store")],
        "channels": ["instagram", "meta_ads", "email", "whatsapp", "creators"],
        "focus": ["revenue", "social_reach", "landing_conversions", "cost_per_lead"],
        "benchmarks": ["meta_cpl_usd", "email_click_pct"],
    },
    "edtech": {
        "label": "Education and edtech", "audiences": ["students", "parents", "institutions", "candidates"],
        "initiatives": [("webinar", "Admissions webinar"), ("campaign", "Enrolment campaign"), ("event", "Open day")],
        "channels": ["instagram", "youtube", "whatsapp", "email", "meta_ads"],
        "focus": ["registrations", "attended", "landing_conversions"],
        "benchmarks": ["webinar_attendance_pct", "meta_cpl_usd", "event_no_show_free_pct"],
    },
    "healthcare": {
        "label": "Healthcare and life sciences", "audiences": ["doctors", "patients", "partners", "regulators"],
        "initiatives": [("event", "Medical conference"), ("webinar", "Continuing education session"), ("campaign", "Awareness campaign")],
        "channels": ["email", "linkedin", "conferences", "press"],
        "focus": ["registrations", "attended", "meetings"],
        "benchmarks": ["webinar_attendance_pct", "email_open_pct"],
    },
    "manufacturing": {
        "label": "Manufacturing and industrial", "audiences": ["distributors", "customers", "partners", "candidates"],
        "initiatives": [("event", "Trade show booth"), ("campaign", "Distributor campaign"), ("hiring", "Plant hiring drive")],
        "channels": ["trade_shows", "email", "linkedin", "distributors"],
        "focus": ["walk_ins", "meetings", "pipeline_value"],
        "benchmarks": ["event_no_show_free_pct", "linkedin_cpl_usd"],
    },
    "real_estate": {
        "label": "Real estate", "audiences": ["buyers", "brokers", "investors"],
        "initiatives": [("event", "Site visit weekend"), ("campaign", "Project launch campaign")],
        "channels": ["meta_ads", "google_ads", "whatsapp", "brokers"],
        "focus": ["registrations", "walk_ins", "cost_per_lead", "meetings"],
        "benchmarks": ["meta_cpl_usd", "event_no_show_free_pct"],
    },
    "hospitality_travel": {
        "label": "Hospitality and travel", "audiences": ["guests", "agents", "corporates"],
        "initiatives": [("campaign", "Season campaign"), ("event", "Agent familiarisation trip")],
        "channels": ["instagram", "meta_ads", "google_ads", "email", "agents"],
        "focus": ["revenue", "landing_conversions", "social_reach"],
        "benchmarks": ["meta_cpl_usd", "email_click_pct"],
    },
    "media_publishing": {
        "label": "Media and publishing", "audiences": ["readers", "advertisers", "creators"],
        "initiatives": [("event", "Annual awards night"), ("campaign", "Subscription drive"), ("webinar", "Advertiser briefing")],
        "channels": ["instagram", "youtube", "x", "email", "newsletter"],
        "focus": ["social_reach", "newsletter_signups", "registrations"],
        "benchmarks": ["email_open_pct", "webinar_attendance_pct"],
    },
    "professional_services": {
        "label": "Professional services and consulting", "audiences": ["clients", "prospects", "alumni", "candidates"],
        "initiatives": [("event", "Executive roundtable"), ("webinar", "Thought-leadership webinar"), ("abm", "Key-account programme")],
        "channels": ["linkedin", "email", "partner_referrals", "events"],
        "focus": ["meetings", "pipeline_value", "accounts_engaged"],
        "benchmarks": ["warm_reply_pct", "webinar_attendance_pct", "linkedin_cpl_usd"],
    },
    "retail_fmcg": {
        "label": "Retail and consumer goods", "audiences": ["shoppers", "retailers", "distributors"],
        "initiatives": [("campaign", "In-store promotion"), ("product", "Product launch"), ("event", "Retailer meet")],
        "channels": ["instagram", "meta_ads", "whatsapp", "retail_media"],
        "focus": ["revenue", "social_reach", "cost_per_lead"],
        "benchmarks": ["meta_cpl_usd"],
    },
    "nonprofit": {
        "label": "Non-profit and foundations", "audiences": ["donors", "volunteers", "beneficiaries", "partners"],
        "initiatives": [("campaign", "Fundraising campaign"), ("event", "Gala dinner"), ("hiring", "Volunteer drive")],
        "channels": ["email", "instagram", "whatsapp", "events"],
        "focus": ["revenue", "registrations", "newsletter_signups"],
        "benchmarks": ["email_open_pct", "event_no_show_free_pct"],
    },
    "government_public": {
        "label": "Government and public sector", "audiences": ["citizens", "businesses", "partners"],
        "initiatives": [("event", "Public consultation"), ("campaign", "Awareness campaign"), ("webinar", "Scheme briefing")],
        "channels": ["press", "x", "youtube", "whatsapp", "email"],
        "focus": ["registrations", "attended", "social_reach"],
        "benchmarks": ["webinar_attendance_pct", "event_no_show_free_pct"],
    },
    "startups_vc": {
        "label": "Startups and venture", "audiences": ["investors", "customers", "candidates", "press"],
        "initiatives": [("event", "Demo day"), ("campaign", "Launch week"), ("hiring", "Founding team hiring")],
        "channels": ["linkedin", "x", "email", "communities", "press"],
        "focus": ["meetings", "registrations", "social_reach", "hires"],
        "benchmarks": ["warm_reply_pct", "cold_reply_pct", "time_to_hire_days"],
    },
}


def guess(text: str | None) -> str | None:
    t = (text or "").lower()
    rules = [("saas_b2b", ("saas", "software", "platform", "api", "b2b", "analytics")), ("fintech_banking", ("bank", "fintech", "payments", "lending", "insurance")),
             ("ecommerce_d2c", ("shop", "store", "d2c", "e-commerce", "ecommerce", "brand", "fashion")), ("edtech", ("school", "college", "university", "course", "edtech", "students")),
             ("healthcare", ("hospital", "clinic", "pharma", "health", "medical")), ("manufacturing", ("manufactur", "industrial", "factory", "plant")),
             ("real_estate", ("real estate", "property", "apartments", "realty")), ("hospitality_travel", ("hotel", "resort", "travel", "tour")),
             ("media_publishing", ("media", "publish", "magazine", "news")), ("professional_services", ("consult", "advisory", "law firm", "accounting", "agency")),
             ("retail_fmcg", ("retail", "fmcg", "consumer goods", "grocery")), ("nonprofit", ("non-profit", "nonprofit", "ngo", "foundation", "charity")),
             ("government_public", ("government", "ministry", "municipal", "public sector")), ("startups_vc", ("startup", "venture", "seed", "founder", "investor"))]
    for key, words in rules:
        if any(w in t for w in words):
            return key
    return None


def benchmarks_for(pack: str | None) -> list[dict]:
    keys = (PACKS.get(pack or "") or {}).get("benchmarks") or ["webinar_attendance_pct", "email_click_pct", "event_no_show_free_pct"]
    return [{"key": k, "low": BENCHMARKS[k]["range"][0], "typical": BENCHMARKS[k]["range"][1], "high": BENCHMARKS[k]["range"][2],
             "source": BENCHMARKS[k]["source"]} for k in keys if k in BENCHMARKS]


def catalog() -> list[dict]:
    return [{"key": k, "label": p["label"], "audiences": p["audiences"], "channels": p["channels"],
             "initiatives": [{"kind": a, "brief": b} for a, b in p["initiatives"]], "focus": p["focus"],
             "benchmarks": benchmarks_for(k)} for k, p in PACKS.items()]
