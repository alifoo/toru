import type { ReactNode } from "react";
import { plans } from "./plans";

type Plan = (typeof plans)[number];
/** The line under each plan's button, the same on every page that shows the plans. */
export const planNote = (id: Plan["id"]) => id === "free" ? "No card required." : id === "creator" ? "Everything you need for regular demos." : "3× the Creator credit allowance.";

/** One plan, drawn the same on the landing page, the pricing page and Billing: only the button differs. */
export function PlanCard({ plan, action, current = false }: { plan: Plan; action: ReactNode; current?: boolean }) {
  const featured = plan.id === "creator";
  return <article className={`price-card${featured ? " price-featured" : ""}${current ? " price-current" : ""}`} aria-labelledby={`plan-${plan.id}`}>
    <div className="price-card-top"><h2 id={`plan-${plan.id}`}>{plan.name}</h2>{current ? <span className="recommended">Your plan</span> : featured && <span className="recommended">Recommended</span>}</div>
    <p className="plan-use">{plan.use}</p><p className="plan-price"><strong>${plan.price}</strong><span>/ month</span></p>
    <ul><li><strong>{plan.credits} credits</strong> per month</li><li>Up to <strong>{plan.minutes} minutes</strong> per capture</li><li><strong>{plan.days} days</strong> of MP4 storage</li></ul>
    {action}
    <small>{planNote(plan.id)}</small>
  </article>;
}

