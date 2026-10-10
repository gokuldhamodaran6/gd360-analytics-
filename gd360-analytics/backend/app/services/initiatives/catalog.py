"""
The fixed knowledge Initiatives works from: the kinds of initiative, the
tools GD360 recommends (and whether each runs inside GD360, connects with a
key, imports from a CSV export, or is simply linked), the metrics an
initiative can be measured on, and a complete starting plan per kind - used
as the planner's fallback when the AI is unavailable and as its reference.
"""
from __future__ import annotations

KINDS = {
    "event": {"label": "Event", "department": "Marketing", "dated": True,
              "board": "Pipeline", "stages": ["Target", "Engaged", "Meeting", "Opportunity", "Customer"]},
    "webinar": {"label": "Webinar", "department": "Marketing", "dated": True,
                "board": "Pipeline", "stages": ["Target", "Engaged", "Meeting", "Opportunity", "Customer"]},
    "campaign": {"label": "Campaign", "department": "Marketing", "dated": False,
                 "board": "Pipeline", "stages": ["Target", "Engaged", "Meeting", "Opportunity", "Customer"]},
    "abm": {"label": "Account-based marketing", "department": "Marketing", "dated": False,
            "board": "Account pipeline", "stages": ["Target", "Engaged", "Meeting", "Opportunity", "Customer"]},
    "hiring": {"label": "Hiring", "department": "People", "dated": True,
               "board": "Candidates", "stages": ["Sourced", "Applied", "Screen", "Interview", "Offer", "Hired"]},
    "product": {"label": "Product build", "department": "Engineering", "dated": True,
                "board": "Build board", "stages": ["Backlog", "Design", "Building", "Review", "Shipped"]},
    "custom": {"label": "Custom", "department": None, "dated": False,
               "board": "Board", "stages": ["To do", "In progress", "Done"]},
}
CLOSED_STAGES = {"Rejected", "Lost", "Dropped"}

# ------------------------------------------------------------------ tools
# mode: native  - runs inside GD360, nothing to set up
#       connect - GD360 connects with the person's own key / token
#       import  - bring a CSV export in (any time; ZoomInfo, Luma, Zoom ...)
#       link    - GD360 tracks it through links / UTM tags; work happens there
TOOLS = {
    "gd360_registration": {"name": "GD360 registration page", "mode": "native", "category": "Registration",
                           "does": "A branded sign-up page for the event; every registrant lands on your account list."},
    "gd360_walkin": {"name": "GD360 walk-in capture", "mode": "native", "category": "On the day",
                     "does": "A phone page for your booth team: capture visitors, interests and meeting requests in seconds."},
    "gd360_email": {"name": "GD360 email campaigns", "mode": "native", "category": "Email",
                    "does": "Invites, reminders and follow-ups to the right ICP tier, with opens, clicks and unsubscribes tracked."},
    "gd360_tracking": {"name": "GD360 website tracking", "mode": "native", "category": "Website",
                       "does": "One line on your site shows which target accounts visit, which pages, and when."},
    "gd360_reminders": {"name": "GD360 reminders", "mode": "native", "category": "Follow-up",
                        "does": "Email nudges for every follow-up, so no hot account goes cold."},
    "gd360_board": {"name": "GD360 board", "mode": "native", "category": "Tracking",
                    "does": "A stage board for candidates, features or accounts, with results counted automatically."},
    "apollo": {"name": "Apollo", "mode": "connect", "category": "Accounts & people",
               "does": "Pull companies that match your ICP and find the right people at each one."},
    "hubspot": {"name": "HubSpot", "mode": "connect", "category": "CRM",
                "does": "Bring your HubSpot companies and contacts in; keep working here or there."},
    "ipinfo": {"name": "IPinfo", "mode": "connect", "category": "Website",
               "does": "Names the company behind anonymous website visits, so target-account visits show up."},
    "zoominfo": {"name": "ZoomInfo", "mode": "import", "category": "Accounts & people",
                 "does": "Export your account or contact list from ZoomInfo and import the CSV - columns are matched for you."},
    "salesforce": {"name": "Salesforce", "mode": "import", "category": "CRM",
                   "does": "Import an accounts or contacts report export."},
    "linkedin": {"name": "LinkedIn", "mode": "link", "category": "Social",
                 "does": "Post and advertise with GD360 tracking links; import the company-engagement report to see which accounts engaged."},
    "linkedin_ads": {"name": "LinkedIn Ads", "mode": "link", "category": "Paid",
                     "does": "Target your Tier A list as a matched audience; import the company report for account-level results."},
    "luma": {"name": "Luma", "mode": "import", "category": "Registration",
             "does": "Prefer Luma? Import its guest list CSV and GD360 matches every guest to an account."},
    "eventbrite": {"name": "Eventbrite", "mode": "import", "category": "Registration",
                   "does": "Import attendees from Eventbrite's export."},
    "zoom": {"name": "Zoom Webinars", "mode": "import", "category": "Webinar",
             "does": "Host on Zoom, then import the attendee report - attendance and duration land on each account."},
    "teams_webinar": {"name": "Microsoft Teams webinars", "mode": "import", "category": "Webinar",
                      "does": "Import the attendance report after the session."},
    "mailchimp": {"name": "Mailchimp", "mode": "import", "category": "Email",
                  "does": "Already have a newsletter list there? Import the audience export."},
    "calendly": {"name": "Calendly", "mode": "link", "category": "Meetings",
                 "does": "Add your booking link to emails; log booked meetings on the account in one click."},
    "slack": {"name": "Slack", "mode": "link", "category": "Team",
              "does": "Keep the team channel; GD360 holds the plan, owners and dates."},
    "greenhouse": {"name": "Greenhouse", "mode": "import", "category": "Hiring",
                   "does": "Using an ATS already? Import candidates; or run the whole pipeline on the GD360 board."},
    "linkedin_jobs": {"name": "LinkedIn Jobs", "mode": "link", "category": "Hiring",
                      "does": "Post roles with a GD360 apply link so every applicant lands on the board."},
    "wellfound": {"name": "Wellfound", "mode": "link", "category": "Hiring",
                  "does": "Startup-focused job board; good reach for engineers."},
    "calendly_interviews": {"name": "Calendly (interviews)", "mode": "link", "category": "Hiring",
                            "does": "Self-serve interview booking for candidates."},
    "linear": {"name": "Linear", "mode": "import", "category": "Engineering",
               "does": "Import issues as board cards (statuses matched to stages), or link each card to its issue."},
    "jira": {"name": "Jira", "mode": "import", "category": "Engineering",
             "does": "Export issues to CSV and import them; statuses become board stages."},
    "asana": {"name": "Asana", "mode": "import", "category": "Project tracking",
              "does": "Import tasks from Asana's CSV export, or link cards to tasks."},
    "clickup": {"name": "ClickUp", "mode": "import", "category": "Project tracking",
                "does": "Import ClickUp's CSV export onto the board."},
    "trello": {"name": "Trello", "mode": "import", "category": "Project tracking",
               "does": "Import cards (lists become stages)."},
    "monday": {"name": "monday.com", "mode": "import", "category": "Project tracking",
               "does": "Import a board export; statuses become stages."},
    "notion": {"name": "Notion", "mode": "import", "category": "Project tracking",
               "does": "Export a Notion database as CSV and import it."},
    "gd360_links": {"name": "GD360 tracked links", "mode": "native", "category": "Tracking",
                    "does": "A short link for every post, ad and landing page: clicks counted, visits attributed, A/B pages compared."},
    "gd360_approvals": {"name": "GD360 approvals", "mode": "native", "category": "Sign-off",
                        "does": "Send a deliverable for approval with a link anyone can open; the decision and version are kept."},
    "ga4": {"name": "Google Analytics 4", "mode": "connect", "category": "Website",
            "does": "Already on GA4? Connect it under Data sources to analyse sessions alongside the plan."},
    "webflow": {"name": "Webflow / WordPress / any site", "mode": "link", "category": "Landing pages",
                "does": "Build the landing page anywhere; paste the GD360 snippet in the page head to track it."},
    "github": {"name": "GitHub", "mode": "link", "category": "Engineering",
               "does": "Code, pull requests and releases; link the release to the Shipped card."},
    "figma": {"name": "Figma", "mode": "link", "category": "Design",
              "does": "Designs linked from each feature card."},
    "google_forms": {"name": "Google Forms", "mode": "link", "category": "Feedback",
                     "does": "Post-event or beta feedback survey."},
    "canva": {"name": "Canva", "mode": "link", "category": "Creative",
              "does": "Banners, social posts and booth graphics."},
}

# --------------------------------------------------------------- metrics
# auto: counted by GD360 from what it tracks; otherwise the owner types the
# actual. unit: count | pct | money
METRICS = {
    "registrations": {"label": "Registrations", "unit": "count", "auto": True},
    "attended": {"label": "Attended", "unit": "count", "auto": True},
    "attendance_rate": {"label": "Attendance rate", "unit": "pct", "auto": True},
    "walk_ins": {"label": "Walk-ins captured", "unit": "count", "auto": True},
    "meetings": {"label": "Meetings booked", "unit": "count", "auto": True},
    "accounts_engaged": {"label": "Target accounts engaged", "unit": "count", "auto": True},
    "tier_a_engaged": {"label": "Tier A accounts engaged", "unit": "count", "auto": True},
    "emails_sent": {"label": "Emails sent", "unit": "count", "auto": True},
    "open_rate": {"label": "Email open rate", "unit": "pct", "auto": True},
    "click_rate": {"label": "Email click rate", "unit": "pct", "auto": True},
    "web_visits": {"label": "Website visits from target accounts", "unit": "count", "auto": True},
    "newsletter_signups": {"label": "Newsletter sign-ups", "unit": "count", "auto": True},
    "opportunities": {"label": "Opportunities created", "unit": "count", "auto": True},
    "candidates": {"label": "Candidates in pipeline", "unit": "count", "auto": True},
    "interviews": {"label": "Candidates interviewed", "unit": "count", "auto": True},
    "offers": {"label": "Offers made", "unit": "count", "auto": True},
    "hires": {"label": "Hires", "unit": "count", "auto": True},
    "items_shipped": {"label": "Items shipped", "unit": "count", "auto": True},
    "items_shipped_pct": {"label": "Scope shipped", "unit": "pct", "auto": True},
    "tasks_done_pct": {"label": "Plan complete", "unit": "pct", "auto": True},
    "landing_visits": {"label": "Landing page visits", "unit": "count", "auto": True},
    "landing_conversions": {"label": "Landing page conversions", "unit": "count", "auto": True},
    "link_clicks": {"label": "Tracked link clicks", "unit": "count", "auto": True},
    "social_reach": {"label": "Social reach", "unit": "count", "auto": True},
    "social_engagements": {"label": "Social engagements", "unit": "count", "auto": True},
    "approvals_done": {"label": "Deliverables approved", "unit": "count", "auto": True},
    "invites_sent": {"label": "Personal invites sent", "unit": "count", "auto": True},
    "replies": {"label": "Replies to personal outreach", "unit": "count", "auto": True},
    "reply_rate": {"label": "Outreach reply rate", "unit": "pct", "auto": True},
    "pipeline_value": {"label": "Pipeline created", "unit": "money", "auto": False},
    "revenue": {"label": "Revenue won", "unit": "money", "auto": False},
    "cost_per_lead": {"label": "Cost per lead", "unit": "money", "auto": False},
    "nps": {"label": "Satisfaction score", "unit": "count", "auto": False},
}


def metric_label(key: str) -> str:
    return (METRICS.get(key) or {}).get("label") or key.replace("_", " ").capitalize()


# -------------------------------------------------------------- templates
# offsets are days relative to the key date (negative = before it); for
# undated kinds they are days from the start.
def _t(title, phase, offset, tool=None, detail=None):
    return {"title": title, "phase": phase, "offset": offset, "tool": tool, "detail": detail}


TEMPLATES: dict[str, dict] = {
    "event": {
        "phases": [
            {"id": "p1", "title": "Plan & budget", "from": -56, "to": -42},
            {"id": "p2", "title": "Audience & promotion", "from": -42, "to": -7},
            {"id": "p3", "title": "Final week", "from": -7, "to": -1},
            {"id": "p4", "title": "On the day", "from": 0, "to": 0},
            {"id": "p5", "title": "Follow-up & results", "from": 1, "to": 14},
        ],
        "tasks": [
            _t("Confirm goal, budget and success targets", "p1", -56),
            _t("Book venue or booth; confirm floor plan", "p1", -52),
            _t("Pick the target accounts this event is for (Tier A first)", "p1", -50, "gd360_board"),
            _t("Open the registration page and share the link", "p2", -42, "gd360_registration"),
            _t("Invite email to Tier A and B accounts", "p2", -40, "gd360_email",
               "Personal note from the account owner; one clear reason to come."),
            _t("Landing page live with the tracking snippet (try two versions)", "p2", -42, "gd360_links"),
            _t("Event creative approved (banner, social posts)", "p2", -38, "gd360_approvals"),
            _t("LinkedIn posts with GD360 tracked links; log reach after 24 hours", "p2", -35, "linkedin"),
            _t("Reminder email to non-openers", "p2", -21, "gd360_email"),
            _t("Personal outreach to Tier A accounts that have not registered", "p2", -14, "apollo"),
            _t("Booth graphics, badges and printed material", "p3", -10, "canva"),
            _t("Final reminder with directions and agenda", "p3", -2, "gd360_email"),
            _t("Brief the booth team on walk-in capture", "p3", -1, "gd360_walkin"),
            _t("Capture every walk-in on the phone page", "p4", 0, "gd360_walkin"),
            _t("Mark who attended", "p4", 0, "gd360_registration"),
            _t("Thank-you email to attendees within 24 hours", "p5", 1, "gd360_email"),
            _t("Book meetings with every walk-in that asked for one", "p5", 3, "calendly"),
            _t("Review results against targets and note what to repeat", "p5", 14),
        ],
        "targets": [("registrations", 150), ("attended", 90), ("walk_ins", 60), ("meetings", 15),
                    ("tier_a_engaged", 20), ("landing_visits", 1500)],
        "tools": ["gd360_registration", "gd360_walkin", "gd360_email", "gd360_links", "gd360_tracking",
                  "gd360_approvals", "apollo", "linkedin", "calendly", "canva"],
    },
    "webinar": {
        "phases": [
            {"id": "p1", "title": "Topic & speakers", "from": -35, "to": -28},
            {"id": "p2", "title": "Promotion", "from": -28, "to": -2},
            {"id": "p3", "title": "Live session", "from": 0, "to": 0},
            {"id": "p4", "title": "Follow-up", "from": 1, "to": 10},
        ],
        "tasks": [
            _t("Pick a topic your Tier A accounts care about; confirm speakers", "p1", -35),
            _t("Set up the session on Zoom or Teams; add the join link to GD360", "p1", -30, "zoom"),
            _t("Open the registration page", "p2", -28, "gd360_registration"),
            _t("Invite email to the ICP list", "p2", -27, "gd360_email"),
            _t("LinkedIn posts with the tracking link", "p2", -21, "linkedin"),
            _t("Second invite to non-openers", "p2", -14, "gd360_email"),
            _t("Reminder the day before with the join link", "p2", -1, "gd360_email"),
            _t("Run the session; collect questions", "p3", 0, "zoom"),
            _t("Import the attendee report", "p4", 1, "zoom"),
            _t("Recording + slides to attendees; 'sorry we missed you' to no-shows", "p4", 1, "gd360_email"),
            _t("Follow up with engaged Tier A accounts personally", "p4", 3, "apollo"),
            _t("Review results and note what to repeat", "p4", 10),
        ],
        "targets": [("registrations", 200), ("attended", 80), ("attendance_rate", 40), ("meetings", 10)],
        "tools": ["gd360_registration", "gd360_email", "zoom", "linkedin", "gd360_tracking", "apollo"],
    },
    "campaign": {
        "phases": [
            {"id": "p1", "title": "Audience & message", "from": 0, "to": 7},
            {"id": "p2", "title": "Launch", "from": 7, "to": 21},
            {"id": "p3", "title": "Optimise & follow up", "from": 21, "to": 42},
        ],
        "tasks": [
            _t("Choose the ICP tiers and segments this campaign is for", "p1", 0, "gd360_board"),
            _t("Write the core message and one clear call to action; get it approved", "p1", 3, "gd360_approvals"),
            _t("Landing page A and B live with the snippet", "p1", 6, "gd360_links"),
            _t("Put the tracking snippet on your website", "p1", 5, "gd360_tracking"),
            _t("Send email 1", "p2", 7, "gd360_email"),
            _t("LinkedIn posts / ads with tracking links", "p2", 8, "linkedin_ads"),
            _t("Send email 2 to openers who did not click", "p2", 14, "gd360_email"),
            _t("Call or message accounts that visited the site", "p3", 21, "apollo"),
            _t("Review open, click and visit rates; adjust the message", "p3", 28),
            _t("Wrap up: results and learnings", "p3", 42),
        ],
        "targets": [("emails_sent", 1000), ("open_rate", 35), ("click_rate", 4), ("accounts_engaged", 80),
                    ("web_visits", 150), ("meetings", 12)],
        "tools": ["gd360_email", "gd360_links", "gd360_tracking", "linkedin_ads", "apollo", "canva"],
    },
    "abm": {
        "phases": [
            {"id": "p1", "title": "Build the list", "from": 0, "to": 10},
            {"id": "p2", "title": "Warm up", "from": 10, "to": 40},
            {"id": "p3", "title": "Engage & meet", "from": 40, "to": 75},
            {"id": "p4", "title": "Convert & review", "from": 75, "to": 90},
        ],
        "tasks": [
            _t("Define the ideal customer profile (industries, size, regions, titles)", "p1", 0),
            _t("Bring in the target accounts (Apollo, ZoomInfo export, HubSpot or CSV)", "p1", 2, "apollo"),
            _t("Check tiers: Tier A gets 1:1, Tier B 1:few, Tier C 1:many", "p1", 5),
            _t("Find 3-5 buying-committee people per Tier A account", "p1", 8, "apollo"),
            _t("Put the website tracking snippet live", "p1", 9, "gd360_tracking"),
            _t("LinkedIn matched-audience ads to Tier A and B", "p2", 10, "linkedin_ads"),
            _t("Email sequence 1 to Tier B and C", "p2", 14, "gd360_email"),
            _t("Personal outreach to Tier A (owner-signed)", "p2", 15),
            _t("Weekly: work the 'surging accounts' list", "p2", 21, "gd360_reminders"),
            _t("Invite engaged accounts to an event or webinar", "p3", 40, "gd360_registration"),
            _t("Book meetings with every account showing 3+ signals", "p3", 45, "calendly"),
            _t("Move accounts on the pipeline board as they progress", "p3", 50, "gd360_board"),
            _t("Review: engaged %, meetings, opportunities; re-tier the list", "p4", 90),
        ],
        "targets": [("accounts_engaged", 200), ("tier_a_engaged", 60), ("web_visits", 400), ("meetings", 40),
                    ("opportunities", 15)],
        "tools": ["apollo", "zoominfo", "hubspot", "gd360_tracking", "ipinfo", "gd360_email", "linkedin_ads",
                  "gd360_reminders", "gd360_board"],
    },
    "hiring": {
        "phases": [
            {"id": "p1", "title": "Define roles", "from": -60, "to": -53},
            {"id": "p2", "title": "Source", "from": -53, "to": -32},
            {"id": "p3", "title": "Interview", "from": -32, "to": -12},
            {"id": "p4", "title": "Offer & onboard", "from": -12, "to": 0},
        ],
        "tasks": [
            _t("Write each role: outcomes in 6 months, must-haves, salary band", "p1", -60),
            _t("Agree the interview loop and scorecard", "p1", -56),
            _t("Post roles with the GD360 apply link", "p2", -53, "linkedin_jobs"),
            _t("Ask the team for referrals", "p2", -52),
            _t("Source 15 profiles per role", "p2", -45, "linkedin"),
            _t("Screen calls within 3 days of applying", "p2", -40, "calendly_interviews"),
            _t("Technical / work-sample interviews", "p3", -32),
            _t("Team interviews and debrief within 24 hours", "p3", -20),
            _t("References and offer approval", "p4", -12),
            _t("Send offers", "p4", -10),
            _t("Onboarding plan, laptop and accounts ready", "p4", -3),
        ],
        "targets": [("candidates", 60), ("interviews", 20), ("offers", 6), ("hires", 5)],
        "tools": ["gd360_board", "linkedin_jobs", "wellfound", "calendly_interviews", "greenhouse", "gd360_reminders"],
    },
    "product": {
        "phases": [
            {"id": "p1", "title": "Discovery & design", "from": -84, "to": -70},
            {"id": "p2", "title": "Build", "from": -70, "to": -21},
            {"id": "p3", "title": "QA & beta", "from": -21, "to": -3},
            {"id": "p4", "title": "Launch", "from": -2, "to": 7},
        ],
        "tasks": [
            _t("Write the problem, who it is for, and how success is measured", "p1", -84),
            _t("Cut the must-have scope for the first release", "p1", -80),
            _t("Designs for the core flows - send for approval with the Figma link", "p1", -74, "gd360_approvals"),
            _t("Break scope into cards on the build board", "p1", -71, "gd360_board"),
            _t("Set up the repo, environments and CI", "p2", -70, "github"),
            _t("Sprint reviews every 2 weeks", "p2", -56, "linear"),
            _t("Feature freeze", "p3", -21),
            _t("QA pass and bug bash", "p3", -18),
            _t("Beta with 5-10 friendly customers; collect feedback", "p3", -14, "google_forms"),
            _t("Launch landing page live with the tracking snippet", "p4", -3, "gd360_links"),
            _t("Launch announcement email", "p4", 0, "gd360_email"),
            _t("Review adoption against the success measure", "p4", 7),
        ],
        "targets": [("items_shipped_pct", 100), ("tasks_done_pct", 100)],
        "tools": ["gd360_board", "gd360_approvals", "figma", "jira", "linear", "asana", "github", "gd360_links",
                  "gd360_email"],
    },
    "custom": {
        "phases": [
            {"id": "p1", "title": "Plan", "from": 0, "to": 7},
            {"id": "p2", "title": "Do", "from": 7, "to": 28},
            {"id": "p3", "title": "Review", "from": 28, "to": 35},
        ],
        "tasks": [
            _t("Agree the goal, owner and how success is measured", "p1", 0),
            _t("List the work and who does it", "p1", 3, "gd360_board"),
            _t("Weekly check-in on progress", "p2", 14, "gd360_reminders"),
            _t("Review results and decide what is next", "p3", 35),
        ],
        "targets": [("tasks_done_pct", 100)],
        "tools": ["gd360_board", "gd360_reminders", "slack"],
    },
}

DEFAULT_WHY = {
    "registrations": "Enough sign-ups for the room after a typical drop-off.",
    "attended": "About 60% of registrants usually turn up to an in-person event.",
    "attendance_rate": "Live webinar attendance usually sits between 35% and 45%.",
    "walk_ins": "Walk-ins are where new accounts come from at a booth.",
    "meetings": "Meetings are the result that matters; everything else leads here.",
    "tier_a_engaged": "Your best-fit accounts are the ones worth the spend.",
    "accounts_engaged": "Engaged = any visit, open, click, registration or meeting.",
    "emails_sent": "Reach across the chosen tiers.",
    "open_rate": "A healthy B2B open rate is 30-40%.",
    "click_rate": "3-5% is a good click rate for a B2B email.",
    "web_visits": "Visits from target accounts show real interest.",
    "opportunities": "Accounts moved to Opportunity on the board.",
    "candidates": "Roughly 12 candidates per hire.",
    "interviews": "About 4 interviews per hire.",
    "offers": "Expect 1 in 5 offers to be declined.",
    "hires": "The roles you set out to fill.",
    "items_shipped_pct": "All must-have scope shipped by launch.",
    "tasks_done_pct": "Every task in the plan finished.",
    "landing_visits": "Visits to the event's landing pages, counted by the GD360 snippet.",
    "social_reach": "Summed from the reach you log after each post.",
}

# questions the planner asks when the brief leaves them open
QUESTIONS = {
    "event": [
        {"key": "format", "question": "What kind of event?", "options": ["Trade show booth", "Our own event", "Meetup / dinner", "Conference talk"]},
        {"key": "audience", "question": "Who is it for?", "options": ["Tier A target accounts", "All ICP accounts", "Existing customers", "Open to anyone"]},
        {"key": "goal", "question": "What matters most?", "options": ["Meetings with target accounts", "New leads", "Brand awareness", "Customer retention"]},
        {"key": "budget", "question": "Budget?", "options": ["Under $5k", "$5k-$20k", "$20k-$50k", "$50k+"]},
    ],
    "webinar": [
        {"key": "audience", "question": "Who is it for?", "options": ["Tier A target accounts", "All ICP accounts", "Customers", "Open to anyone"]},
        {"key": "platform", "question": "Where will it run?", "options": ["Zoom", "Microsoft Teams", "Google Meet", "Not decided"]},
        {"key": "goal", "question": "What matters most?", "options": ["Meetings booked", "Registrations", "Education / retention"]},
    ],
    "campaign": [
        {"key": "audience", "question": "Who should it reach?", "options": ["Tier A", "Tier A + B", "All ICP accounts", "Newsletter list"]},
        {"key": "channels", "question": "Which channels?", "options": ["Email", "Email + LinkedIn", "Email + LinkedIn + ads"]},
        {"key": "goal", "question": "What matters most?", "options": ["Meetings", "Website visits", "Sign-ups", "Awareness"]},
    ],
    "abm": [
        {"key": "accounts", "question": "How many target accounts?", "options": ["Up to 100", "About 500", "1,000+"]},
        {"key": "source", "question": "Where is your account list today?", "options": ["Apollo", "ZoomInfo", "HubSpot", "A spreadsheet", "Nowhere yet"]},
        {"key": "goal", "question": "What matters most?", "options": ["Meetings", "Pipeline", "Expansion in existing accounts"]},
    ],
    "hiring": [
        {"key": "roles", "question": "Which roles?", "options": ["Engineers", "Sales", "Marketing", "Mixed"]},
        {"key": "seniority", "question": "Seniority?", "options": ["Junior", "Mid", "Senior", "Mixed"]},
        {"key": "where", "question": "Where will they work?", "options": ["Remote", "Hybrid", "On-site"]},
    ],
    "product": [
        {"key": "stage", "question": "How clear is the idea?", "options": ["Just an idea", "Problem is clear", "Scope is written"]},
        {"key": "team", "question": "Team today?", "options": ["Solo", "2-3 people", "4-8 people", "Hiring for it"]},
        {"key": "stack", "question": "Where does the team track work?", "options": ["Linear", "Jira", "GitHub", "Nothing yet"]},
    ],
    "custom": [
        {"key": "department", "question": "Which team?", "options": ["Marketing", "Sales", "Operations", "Finance", "People", "Engineering"]},
        {"key": "goal", "question": "What does done look like?", "options": ["A launch", "A number to hit", "A process in place"]},
    ],
}


def guess_kind(text: str) -> str:
    t = (text or "").lower()
    rules = [
        ("webinar", ("webinar", "online session", "live session", "web seminar")),
        ("hiring", ("hire", "hiring", "recruit", "candidates", "headcount", "job opening")),
        ("abm", ("abm", "account-based", "account based", "target accounts", "500 accounts", "icp", "zoominfo", "apollo")),
        ("product", ("build a product", "mvp", "app", "software", "feature", "launch a product", "platform", "portal")),
        ("event", ("event", "trade show", "tradeshow", "booth", "expo", "conference", "summit", "meetup", "showcase", "walk-in", "walkin")),
        ("campaign", ("campaign", "newsletter", "email blast", "promotion", "outreach", "nurture")),
    ]
    for kind, words in rules:
        if any(w in t for w in words):
            return kind
    return "custom"
