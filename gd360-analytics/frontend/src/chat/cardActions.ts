// 2026-10-19 (R58): what a studio card can do with the thread, without threading props through every canvas.
//  - explain: answered at once from the numbers already computed (no plan, no query) - the card's Explain button
//  - about:   the card's Ask - the follow-up box shows "About: <card> ×" and the question goes with that card
import { createContext, useContext } from "react";

export type CardTarget =
  | { kind: "visual"; index: number }
  | { kind: "step"; id: string }
  | { kind: "kpis" }
  | { kind: "answer" }
  | { kind: "cause"; index: number };

export type About = { label: string; prefix: string; target: CardTarget; runId: string };

export type CardActions = {
  explain: (label: string, target: CardTarget, runId: string) => void;
  about: (a: About) => void;
};

export const CardActionsContext = createContext<CardActions | null>(null);
export const useCardActions = () => useContext(CardActionsContext);
