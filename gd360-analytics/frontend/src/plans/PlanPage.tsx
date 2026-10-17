// 2026-10-17 (R52): Settings > Plan & usage, inside the one shell. Your plan, what you have used, every plan side by
// side from the same catalog the pricing page shows. Billing is not switched on yet, and the page says so.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { v2Api, type PlanSummary } from "../api/v2";
import { Shell } from "../chat/Shell";
import TopNav from "../components/TopNav";
import { CompareTable, Meters, PlanCards, priceOf } from "./PlanParts";

export default function PlanPage() {
  const [plan, setPlan] = useState<PlanSummary | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => { let live = true; v2Api.plan().then((p) => live && setPlan(p)).catch(() => live && setErr("Your plan didn't load. Refresh to try again.")); return () => { live = false; }; }, []);
  const pr = plan ? priceOf(plan) : null;
  return (
    <Shell>
      <div style={{ flex: 1, minWidth: 0, minHeight: "100vh", display: "flex", flexDirection: "column" }}>
        <TopNav breadcrumb={[{ label: "Settings", to: "/profile" }, { label: "Plan & usage" }]} />
        <div className="pl pl-page" data-pl-page="">
          {err && <div className="c2-err">{err}</div>}
          {plan && pr && (
            <>
              <div className="pl-head">
                <div>
                  <span className="pl-eb">Your plan</span>
                  <h1 data-pl-title="">{plan.label} · {pr.big === "Custom" ? "custom terms" : `${pr.big} ${pr.small.split(" · ")[0]}`}</h1>
                  <p>{plan.who}. Every feature is on every plan; plans differ by people, data, governance and where it runs.
                    {plan.enforced ? " Limits below are enforced." : " During early access nothing below is enforced, and nothing is billed."}</p>
                </div>
                <div className="pl-row">
                  <Link to="/pricing" className="pl-btn">See pricing</Link>
                  <Link to="/pricing#enterprise" className="pl-btn p">Talk to us</Link>
                </div>
              </div>
              <section className="pl-sec" aria-labelledby="pl-use">
                <h2 id="pl-use">What you've used</h2>
                <Meters plan={plan} />
              </section>
              <section className="pl-sec" aria-labelledby="pl-all">
                <h2 id="pl-all">Every plan</h2>
                <PlanCards plans={plan.plans} current={plan.plan} enforced={plan.enforced}
                  action={(k) => k === plan.plan ? <span className="pl-btn" aria-disabled="true">Current plan</span>
                    : <Link className="pl-btn" to={k === "enterprise" ? "/pricing#enterprise" : `/pricing?plan=${k}`}>{k === "enterprise" ? "Talk to us" : "Compare"}</Link>} />
              </section>
              <section className="pl-sec" aria-labelledby="pl-lim">
                <h2 id="pl-lim">Limits side by side</h2>
                <CompareTable plans={plan.plans} current={plan.plan} />
              </section>
            </>
          )}
          {!plan && !err && <div className="c2-working"><span className="c2-spin" /> Loading your plan…</div>}
        </div>
      </div>
    </Shell>
  );
}
