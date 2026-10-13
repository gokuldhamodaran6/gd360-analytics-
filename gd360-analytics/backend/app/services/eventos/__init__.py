"""
2026-10-13 (round 42): Event OS.

One event - offline, online, webinar, hybrid or a meetup - tracked before,
during and after, scored against what the people who judge it expected.
An event is an Initiative of kind "event" or "webinar"; Event OS adds:

  core       setup (format, times, capacity, hashtags, codes), the three
             time windows (before / during / after), tickets
  ctx        everything loaded once per request (tickets, touches, posts,
             ads, deals, sponsors ...) and every metric computed from it
  score      the expectation contract: 0 at the low end of a range, 70 on
             target, 100 at the top; weighted; confidence = share of the
             weight backed by counted / matched / tested numbers
  forecast   registrations by the event day, who will really come, and
             5,000 simulated events for the odds of each goal
  social     posts about the event, before / during / after: synced own
             accounts, X and YouTube search when keys are set, links added
             by hand; matched by hashtag, link, code, words or the banner
             in the image (vision)
  ads        spend from the synced Meta / Google Ads tables, by the
             INIT-{code} naming rule or campaigns mapped by hand
  pipeline   HubSpot deals matched to the companies that came
  views      the payloads the screens draw (Event 360, growth, buzz,
             demand, live, sponsors, report)
  agent      suggestions per phase; approving one does it (when it can)
  export     the A to Z workbook (Excel)
  vision     business-card reading and banner matching (Gemini)
  sample     a complete sample event to explore every screen

Every number carries a truth label: counted, matched, reported, modelled
or tested.
"""
