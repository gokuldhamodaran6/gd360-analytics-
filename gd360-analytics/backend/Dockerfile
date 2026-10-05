FROM python:3.11-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc libpq-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p /app/uploads

# 2026-10-05: without this, Python buffers stdout in a Docker container
# (it isn't a tty), so every print() - including the [chat]/[ai_engine]/
# [sandbox] diagnostic lines this app leans on throughout to explain a
# failure after the fact - sits in a buffer instead of reaching Render's
# log stream right away. Confirmed directly from a real incident: a chat
# request that (per Render's own memory graph) climbed from ~216MB to
# ~427MB+ and ended in "Instance restarted" left ZERO applicaton log
# lines between the request starting and the crash - every diagnostic
# print() that would have explained it was lost with the buffer when the
# container died. This makes every future print reach the log stream the
# moment it is written, so a crash like that one is never silent again.
ENV PYTHONUNBUFFERED=1

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
