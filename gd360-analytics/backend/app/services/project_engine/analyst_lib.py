"""
GD360 Analyst helper library (2026-10-13, R43).

Small, tested building blocks the Analyst's generated code can call inside
the sandbox, so the common hard parts of business maths are exact every
time instead of re-invented per question: queues, money over time,
break-even, optimisation, inventory and Monte Carlo. Pure functions over
numbers and pandas - no I/O.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd


def simulate_queue(arrival_times, service_times, servers: int = 1) -> pd.DataFrame:
    """Re-runs a first-come-first-served queue with `servers` identical
    servers. Each customer goes to whichever server is free first (ties: the
    lowest number). `arrival_times` are clock times (not gaps), in order.
    Returns one row per customer: arrival, server, start, end, wait."""
    arr = [float(a) for a in arrival_times]
    svc = [float(s) for s in service_times]
    if len(arr) != len(svc):
        raise ValueError("arrival_times and service_times must have the same length")
    k = max(1, int(servers))
    free = [0.0] * k
    rows = []
    for i, (a, s) in enumerate(zip(arr, svc)):
        j = min(range(k), key=lambda x: (free[x], x))
        start = max(a, free[j])
        end = start + s
        free[j] = end
        rows.append({"customer": i + 1, "arrival": a, "server": j + 1, "start": start, "end": end, "wait": start - a, "service": s})
    return pd.DataFrame(rows)


def queue_summary(sim: pd.DataFrame, threshold: float | None = None) -> dict:
    """Headline numbers of a simulate_queue result."""
    out = {
        "customers": int(len(sim)),
        "total_wait": float(sim["wait"].sum()),
        "avg_wait": float(sim["wait"].mean()) if len(sim) else 0.0,
        "max_wait": float(sim["wait"].max()) if len(sim) else 0.0,
        "customers_who_waited": int((sim["wait"] > 0).sum()),
        "last_finish": float(sim["end"].max()) if len(sim) else 0.0,
    }
    if threshold is not None:
        out[f"waited_over_{threshold:g}"] = int((sim["wait"] > threshold).sum())
    span = out["last_finish"] - float(sim["arrival"].min()) if len(sim) else 0.0
    if span > 0:
        busy = sim.groupby("server")["service"].sum()
        out["utilisation"] = {int(k): float(v / span) for k, v in busy.items()}
    return out


def erlang_c(arrival_rate: float, service_rate: float, servers: int) -> dict:
    """M/M/c steady state: probability of waiting, average wait (Wq) and time
    in system (W), in the same time unit as the rates. Utilisation >= 1
    means the queue grows without limit."""
    lam, mu, c = float(arrival_rate), float(service_rate), int(servers)
    rho = lam / (c * mu)
    if rho >= 1:
        return {"utilisation": rho, "p_wait": 1.0, "avg_wait": math.inf, "avg_time_in_system": math.inf, "stable": False}
    a = lam / mu
    s = sum(a ** n / math.factorial(n) for n in range(c))
    top = a ** c / math.factorial(c) / (1 - rho)
    p_wait = top / (s + top)
    wq = p_wait / (c * mu - lam)
    return {"utilisation": rho, "p_wait": p_wait, "avg_wait": wq, "avg_time_in_system": wq + 1 / mu, "stable": True}


def npv(rate: float, cash_flows, t0: int = 0) -> float:
    """Net present value; cash_flows[0] happens at period t0 (default now)."""
    return float(sum(cf / (1 + rate) ** (i + t0) for i, cf in enumerate(cash_flows)))


def irr(cash_flows, lo: float = -0.99, hi: float = 10.0) -> float | None:
    """Internal rate of return by bisection; None when it does not exist."""
    f = lambda r: npv(r, cash_flows)  # noqa: E731
    flo, fhi = f(lo), f(hi)
    if flo * fhi > 0:
        return None
    for _ in range(200):
        mid = (lo + hi) / 2
        fm = f(mid)
        if abs(fm) < 1e-9:
            return float(mid)
        if flo * fm < 0:
            hi, fhi = mid, fm
        else:
            lo, flo = mid, fm
    return float((lo + hi) / 2)


def payback_period(cash_flows) -> float | None:
    """Periods until the running total turns non-negative (interpolated)."""
    total = 0.0
    for i, cf in enumerate(cash_flows):
        prev = total
        total += cf
        if total >= 0 and i > 0:
            return float(i - 1 + (-prev / cf if cf else 0))
    return None


def break_even(fixed_cost: float, price: float, variable_cost: float) -> float | None:
    """Units needed for revenue to cover fixed + variable cost."""
    margin = price - variable_cost
    return float(fixed_cost / margin) if margin > 0 else None


def crossover(a_fixed: float, a_per_unit: float, b_fixed: float, b_per_unit: float) -> float | None:
    """The x where two straight-line costs a_fixed + a_per_unit*x and
    b_fixed + b_per_unit*x are equal (None when they are parallel)."""
    if a_per_unit == b_per_unit:
        return None
    return float((b_fixed - a_fixed) / (a_per_unit - b_per_unit))


def eoq(annual_demand: float, order_cost: float, holding_cost_per_unit: float) -> dict:
    """Economic order quantity and its yearly costs."""
    q = math.sqrt(2 * annual_demand * order_cost / holding_cost_per_unit)
    return {"order_quantity": q, "orders_per_year": annual_demand / q,
            "ordering_cost": annual_demand / q * order_cost, "holding_cost": q / 2 * holding_cost_per_unit}


def newsvendor(mean: float, sd: float, price: float, cost: float, salvage: float = 0.0) -> dict:
    """Best order size for one selling season with normal demand."""
    from scipy import stats as _st
    cu, co = price - cost, cost - salvage
    ratio = cu / (cu + co)
    q = _st.norm.ppf(ratio, mean, sd)
    return {"critical_ratio": ratio, "order_quantity": float(q)}


def monte_carlo(fn, n: int = 2000, seed: int = 42) -> np.ndarray:
    """Calls fn(rng) n times with one seeded generator; returns the results
    as an array (use np.percentile / mean on it)."""
    rng = np.random.default_rng(seed)
    return np.array([fn(rng) for _ in range(int(n))])


def percentile_summary(values, ps=(10, 50, 90)) -> dict:
    v = np.asarray(values, dtype=float)
    return {f"p{p}": float(np.percentile(v, p)) for p in ps} | {"mean": float(v.mean()), "sd": float(v.std(ddof=1)) if len(v) > 1 else 0.0}


def table_from_random(rng, inter_arrival_choices, inter_arrival_probs, service_choices, service_probs, n: int) -> pd.DataFrame:
    """Builds a textbook simulation table from discrete distributions (the
    classic 'random number' spreadsheet): random numbers 0-99, gaps, clock
    times and service times."""
    ia = rng.choice(inter_arrival_choices, size=n, p=inter_arrival_probs)
    sv = rng.choice(service_choices, size=n, p=service_probs)
    clock = np.cumsum(ia)
    return pd.DataFrame({"customer": np.arange(1, n + 1), "inter_arrival": ia, "arrival": clock, "service": sv})


HELPERS = {
    "simulate_queue": simulate_queue, "queue_summary": queue_summary, "erlang_c": erlang_c,
    "npv": npv, "irr": irr, "payback_period": payback_period, "break_even": break_even, "crossover": crossover,
    "eoq": eoq, "newsvendor": newsvendor, "monte_carlo": monte_carlo, "percentile_summary": percentile_summary,
    "table_from_random": table_from_random,
}

HELPER_DOC = """Helpers already defined (call them; do not redefine):
- simulate_queue(arrival_times, service_times, servers=1) -> DataFrame[customer, arrival, server, start, end, wait, service]
  first-come-first-served, each customer to the server that frees up first. arrival_times are clock times.
- queue_summary(sim, threshold=None) -> {customers, total_wait, avg_wait, max_wait, customers_who_waited, last_finish, utilisation{server: share}}
- erlang_c(arrival_rate, service_rate, servers) -> {utilisation, p_wait, avg_wait, avg_time_in_system, stable}
- npv(rate, cash_flows, t0=0), irr(cash_flows), payback_period(cash_flows)
- break_even(fixed_cost, price, variable_cost) -> units; crossover(a_fixed, a_per_unit, b_fixed, b_per_unit) -> x
- eoq(annual_demand, order_cost, holding_cost_per_unit), newsvendor(mean, sd, price, cost, salvage=0)
- monte_carlo(fn, n=2000, seed=42) -> np.array of fn(rng) results; percentile_summary(values) -> {p10, p50, p90, mean, sd}
- table_from_random(rng, inter_arrival_choices, inter_arrival_probs, service_choices, service_probs, n)
Also available: pd, np, stats (scipy.stats), optimize (scipy.optimize: linprog, minimize, minimize_scalar, brentq),
math, statistics, itertools, and rng = np.random.default_rng(42)."""
