"""
Initiatives (2026-10-10) - plan, run and prove any activity in one place.

An initiative is anything a team sets out to do with a date and a result in
mind: an event, a webinar, a marketing campaign, an account-based push on a
list of target accounts, hiring a team, building a product, or any custom
department activity. GD360 writes the plan (phases, tasks, targets, which
tools to use and why - learned from the workspace's earlier initiatives),
then runs and measures it natively: registration and walk-in pages, website
visit tracking, email campaigns with open and click tracking, reminders, a
board for candidates / features / accounts, and an assistant that answers
and acts on the plan.

The go-to-market layer the initiatives share (target accounts scored on the
ideal customer profile, their people, and every engagement signal) lives in
gtm.py; nothing here needs another tool, but Apollo, HubSpot and IPinfo can
be connected and CSV exports from ZoomInfo, Salesforce, LinkedIn, Luma,
Eventbrite, Zoom, Mailchimp or Greenhouse can be imported at any time.

  catalog.py    kinds, templates, the tool catalog, metric definitions
  planner.py    the AI planner (with a deterministic fallback)
  gtm.py        accounts, contacts, ICP scoring, imports, Apollo/HubSpot/IPinfo
  campaigns.py  audiences, sending, open/click/unsubscribe tracking
  metrics.py    initiative results, the hub, "needs you today", the ABM overview
  assistant.py  the initiative assistant (answers + safe actions)
  reminders.py  due reminders and scheduled campaigns (scheduler tick)
"""
