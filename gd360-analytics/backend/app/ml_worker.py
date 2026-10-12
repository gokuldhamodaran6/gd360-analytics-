"""
The ML worker service (2026-10-12, round 39): `python -m app.ml_worker`.

Run it as its own service (a Render Background Worker with the same image
and environment as the API, plus more memory) and set ML_WORKER_MODE=external
on the API: the API then only queues ML runs and this service trains and
scores them, so a big model never competes with the app for memory.
ML_WORKERS (default 1) runs several jobs side by side.
"""
from __future__ import annotations

import logging
import os
import signal
import threading

from .database import init_db
from .services import ml_queue, ml_worker


def main() -> None:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    init_db()
    stop = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop.set())
    signal.signal(signal.SIGINT, lambda *_: stop.set())
    n = max(1, int(os.environ.get("ML_WORKERS", "1")))
    threads = [threading.Thread(target=ml_worker.run_forever, args=(ml_queue.worker_name(i), stop), daemon=True) for i in range(n)]
    for t in threads:
        t.start()
    stop.wait()
    for t in threads:
        t.join(timeout=30)


if __name__ == "__main__":
    main()
