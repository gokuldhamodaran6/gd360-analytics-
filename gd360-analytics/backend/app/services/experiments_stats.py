"""
Phase 4 (Experimentation / A/B testing, 2026-09-28) - significance
computation for one Experiment's two variants.

No existing significance-testing convention exists anywhere else in this
codebase to follow. The only real precedent is "scipy.stats is the vendored
library for this kind of thing" - services/chart_builder.py already uses
scipy.stats.linregress and scipy.stats.t.ppf to build a trendline's
confidence band - so this reuses scipy.stats here too (a plain two-proportion
z-test) rather than hand-rolling a normal-distribution CDF.

Kept as its own small module, not inlined into routers/experiments.py, so it
can be unit-tested directly with plain integers in and a plain dict out -
no FastAPI, no database, no request/response models involved at all.
"""
from scipy.stats import norm


def compute_experiment_stats(n_a: int, conv_a: int, n_b: int, conv_b: int) -> dict:
    """Two-proportion z-test comparing variant A's and B's conversion rates.

    Args:
        n_a: how many subjects have been assigned to variant A so far.
        conv_a: how many of those have converted so far.
        n_b / conv_b: the same, for variant B.

    Returns a dict with:
        rate_a, rate_b: conv/n for each variant, or None when that
            variant's own n is 0 - a conversion rate is genuinely undefined
            with a zero denominator, never reported as a fabricated 0.0
            (this function never guesses a number it doesn't have).
        p_value: the two-tailed p-value from the z-test, or None when
            insufficient_data is True (there is nothing to test yet).
        is_significant: True only when p_value is not None and < 0.05.
        insufficient_data: True whenever n_a == 0 or n_b == 0 - this
            function never fabricates a p-value from zero samples in
            either group, matching this codebase's existing honesty
            convention around every other "live"/computed stat (see e.g.
            models.DataSource.last_event_at's own docstring, which applies
            the identical rule to a timestamp instead of a statistic: never
            backdated, defaulted, or simulated).
    """
    rate_a = (conv_a / n_a) if n_a else None
    rate_b = (conv_b / n_b) if n_b else None

    if n_a == 0 or n_b == 0:
        return {
            "rate_a": rate_a,
            "rate_b": rate_b,
            "p_value": None,
            "is_significant": False,
            "insufficient_data": True,
        }

    p_pool = (conv_a + conv_b) / (n_a + n_b)
    se = (p_pool * (1 - p_pool) * (1 / n_a + 1 / n_b)) ** 0.5

    if se == 0:
        # Every subject in both groups converted, or none anywhere did -
        # there is no measurable spread to test against, so there is no
        # measurable difference either. Never a ZeroDivisionError computing
        # z below, and never a fabricated p_value - 1.0 (no evidence of a
        # difference) is the honest answer when nothing varies at all.
        p_value = 1.0
        is_significant = False
    else:
        z = (rate_a - rate_b) / se
        p_value = float(2 * (1 - norm.cdf(abs(z))))
        is_significant = p_value < 0.05

    return {
        "rate_a": rate_a,
        "rate_b": rate_b,
        "p_value": p_value,
        "is_significant": is_significant,
        "insufficient_data": False,
    }
