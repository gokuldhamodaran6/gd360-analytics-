"""2026-10-14 (R46, GD360 2.0): the conversation engine behind /v2.

One assistant, reached by a sentence. A turn is routed to a tool:

- knowledge   a world question, answered with web grounding and sources (knowledge.py)
- data        a question on the person's data, answered by the project engine
              (routers/projects.py + services/project_engine) and shown prose-first
- guided      the same question, step by step (the Guided engine, inside the chat)
- dashboard   a dashboard built from an answer in this conversation
- document    a written document from the answers so far (documents.py)
- automation  an alert or a schedule set up from a sentence, with a confirm card
              (automations_tool.py)
- chat        small talk, thanks, "what can you do"

Every answer is checked by truth_guard.py before the chips are shown; nothing is
claimed that was not verified. Turns are stored on models.Message.chart_spec["v2"]
so the classic project page can still open the same conversation.
"""
