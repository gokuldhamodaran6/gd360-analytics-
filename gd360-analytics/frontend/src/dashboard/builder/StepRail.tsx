import { CheckIcon, cn } from "../../ui";
import type { BuilderStep } from "./useProposalFlow";

// Builder.dc.html's step pill row: Describe → Propose → Refine → Publish.
// A done step shows a check on tint, the current one a filled brand disc
// and a subtle background, the rest an outlined number.

const STEPS: { id: BuilderStep; label: string }[] = [
  { id: "describe", label: "Describe" },
  { id: "propose", label: "Propose" },
  { id: "refine", label: "Refine" },
  { id: "publish", label: "Publish" },
];

export function StepRail({ step, className }: { step: BuilderStep; className?: string }) {
  const current = STEPS.findIndex((s) => s.id === step);
  return (
    <ol data-step-rail="" aria-label="Steps" className={cn("inline-flex max-w-full items-center overflow-x-auto rounded-full border border-border bg-surface p-1", className)}>
      {STEPS.map((s, i) => {
        const state = i < current ? "done" : i === current ? "current" : "todo";
        return (
          <li key={s.id} className="flex items-center" data-step={s.id} data-state={state} aria-current={state === "current" ? "step" : undefined}>
            {i > 0 && <span aria-hidden="true" className="mx-0.5 h-px w-4 bg-border-strong" />}
            <span
              className={cn(
                "inline-flex items-center gap-2 whitespace-nowrap rounded-full py-[5px] pl-2 pr-3.5 text-ui",
                state === "current" ? "bg-subtle font-semibold text-text" : state === "done" ? "text-secondary" : "text-muted"
              )}
            >
              <span
                className={cn(
                  "inline-flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-semibold",
                  state === "done" && "border border-tint-border bg-tint text-brand-ink",
                  state === "current" && "bg-primary text-on-primary",
                  state === "todo" && "border border-border-strong text-muted"
                )}
              >
                {state === "done" ? <CheckIcon size={11} strokeWidth={2.6} /> : i + 1}
              </span>
              {s.label}
            </span>
          </li>
        );
      })}
    </ol>
  );
}
