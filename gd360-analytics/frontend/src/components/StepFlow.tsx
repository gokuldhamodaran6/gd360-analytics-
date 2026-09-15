export type WorkflowStep = "clean" | "explore" | "visualize" | "export";

type StepDef = {
  key: WorkflowStep;
  label: string;
  description: string;
  chips: string[];
};

const STEPS: StepDef[] = [
  {
    key: "clean",
    label: "Prepare & Clean",
    description: "Fix missing values, remove duplicates and outliers, standardize types - just describe what you need.",
    chips: [
      "Clean and prepare this data for analysis",
      "Remove duplicate rows",
      "Fill in missing values",
      "Remove outliers",
    ],
  },
  {
    key: "explore",
    label: "Explore & Analyze",
    description: "Look for patterns, categories, and relationships in the data.",
    chips: [
      "Find patterns in this data",
      "Categorize this data into meaningful groups",
      "What correlations exist between the numeric columns?",
      "Summarize this dataset",
    ],
  },
  {
    key: "visualize",
    label: "Visualize",
    description: "Build charts from what you found - ask for any chart type, in plain English.",
    chips: [
      "Show me the trend over time",
      "Compare the key categories in a bar chart",
      "Show the distribution of the main numeric column",
    ],
  },
  {
    key: "export",
    label: "Export",
    description: "Switch to the Data tab to download your table as CSV or Excel, or use the export buttons above any chart.",
    chips: [],
  },
];

export default function StepFlow({
  activeStep,
  onStepChange,
  guided,
  onToggleGuided,
  onSend,
  busy,
}: {
  activeStep: WorkflowStep;
  onStepChange: (s: WorkflowStep) => void;
  guided: boolean;
  onToggleGuided: () => void;
  onSend: (prompt: string) => void;
  busy: boolean;
}) {
  if (!guided) {
    return (
      <div className="flex items-center justify-between px-4 py-2.5 bg-surface2 border border-border rounded-xl mb-3">
        <div className="text-xs text-muted">Pro mode - guided steps are hidden. Just ask GD360 anything in the chat.</div>
        <button className="btn-secondary text-xs px-3 py-1" onClick={onToggleGuided}>
          Show guided steps
        </button>
      </div>
    );
  }

  const currentIndex = STEPS.findIndex((s) => s.key === activeStep);
  const current = STEPS[currentIndex] || STEPS[0];

  return (
    <div className="card p-4 mb-3">
      <div className="flex items-center justify-between mb-3 gap-3 flex-wrap">
        <div className="flex items-center gap-1.5 flex-wrap">
          {STEPS.map((s, i) => (
            <div key={s.key} className="flex items-center gap-1.5">
              <button
                onClick={() => onStepChange(s.key)}
                className={`text-xs px-3 py-1.5 rounded-full font-medium transition whitespace-nowrap ${
                  s.key === activeStep
                    ? "bg-primary text-white"
                    : i < currentIndex
                    ? "bg-accent/20 text-accent"
                    : "bg-surface2 text-muted border border-border"
                }`}
              >
                {i + 1}. {s.label}
              </button>
              {i < STEPS.length - 1 && <span className="text-muted text-xs">&rarr;</span>}
            </div>
          ))}
        </div>
        <button className="text-xs text-muted hover:text-text underline shrink-0" onClick={onToggleGuided}>
          Skip guided steps
        </button>
      </div>

      <div className="text-xs text-muted mb-2.5">{current.description}</div>

      {current.chips.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {current.chips.map((chip) => (
            <button
              key={chip}
              disabled={busy}
              className="text-xs bg-surface2 hover:bg-[#21213A] border border-border rounded-lg px-3 py-1.5 transition disabled:opacity-50"
              onClick={() => onSend(chip)}
            >
              {chip}
            </button>
          ))}
        </div>
      )}

      {currentIndex < STEPS.length - 1 && (
        <div className="mt-3 flex justify-end">
          <button className="btn-secondary text-xs px-3 py-1.5" onClick={() => onStepChange(STEPS[currentIndex + 1].key)}>
            Next step &rarr;
          </button>
        </div>
      )}
    </div>
  );
}
