"""
Multi-source Projects (2026-10-08, round 11).

One question, answered across every data source in a Project:

  catalog   - what each source holds (tables, columns, how it is queried,
              how fresh it is) and the keys the sources share.
  planner   - the language model turns the question into a typed plan: one
              small query per source, an optional DuckDB step that joins
              the small results, and the analysis to run on them. Every
              query is parsed and checked against the catalog before it
              is allowed to run.
  executor  - runs the plan: each step in its own source (warehouses in
              place through services/warehouse_exec, files and synced app
              tables through DuckDB), in parallel, read-only, with the
              person's access rules applied. Only small results come back.
  analysis  - deterministic statistics on those results: the change and
              its split into parts, drivers ranked by how much of the
              change they explain, trends, breakdowns.
  composer  - the language model writes the explanation from the computed
              facts only; a number checker blocks any number that is not
              one of them.

routers/projects.py is the HTTP surface; models.ProjectRun stores it all.
"""
