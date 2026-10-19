"""R54 - Automate data (data flows).

Describe a data job in plain words; GD360 reads the sources, finds their
mistakes, proposes a plan (clean -> combine -> compute -> check -> save),
test-runs it on real rows, then runs it on a schedule. When the data goes
wrong it holds the output back, explains why and proposes a fix to approve.

Modules:
  values   - turning messy cell values into keys and numbers
  profile  - reading sources, finding the link between them and their mistakes
  plan     - turning a request + profile into a spec
  spec     - validating a spec, describing it in words, showing it as SQL
  engine   - running a spec on real data
  fix      - explaining a held/failed run and proposing a repair
  runner   - background runs, saving the output, alerts, schedule and change triggers
  chat     - plain-word edits from the thread
  service  - what the router calls
"""
