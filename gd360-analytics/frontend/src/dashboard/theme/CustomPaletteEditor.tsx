import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowDownIcon, ArrowUpIcon, Button, GripIcon, IconButton, Input, PlusIcon, StatusPill, Switch, Textarea, TrashIcon, cn } from "../../ui";
import type { PaletteChoice } from "./appearance";
import { PALETTES, parseHex, validateCustomPalette, type Mode } from "./palettes";

// 2026-10-07 (identity-colour round): "Custom palette" in the Appearance
// sheet - up to ten of the customer's own brand colours, typed, picked,
// pasted as a list, dragged (or stepped) into order. Every edit is checked
// live by palettes.validateCustomPalette for the theme on screen AND the
// other one, and the sheet says exactly what that found: how many colours
// were adjusted so they stay distinguishable, the before and after of each,
// and a switch to use the adjusted set (the default) or keep the colours
// as typed - with a plain warning when those are hard to tell apart.

export const MAX_CUSTOM = 10;

/** Hex colours out of pasted text: commas, spaces, newlines, with or without "#". */
export function parseColorList(text: string): string[] {
  const out: string[] = [];
  for (const token of String(text || "").split(/[\s,;|]+/)) {
    const hex = parseHex(token);
    if (hex) out.push(hex);
    if (out.length >= MAX_CUSTOM) break;
  }
  return out;
}

export type CustomPaletteEditorProps = {
  value: Extract<PaletteChoice, { kind: "custom" }> | null;
  mode: Mode;
  disabled?: boolean;
  // Called with the palette to apply (every edit once `value` is the
  // dashboard's palette, or on "Use this palette").
  onApply: (palette: Extract<PaletteChoice, { kind: "custom" }>) => void;
  // The dashboard's current palette is this custom one (edits apply live).
  active: boolean;
};

const STARTER = PALETTES[0].light.slice(0, 4);

export function CustomPaletteEditor({ value, mode, disabled = false, onApply, active }: CustomPaletteEditorProps) {
  const [colors, setColors] = useState<string[]>(() => (value?.colors?.length ? value.colors : [...STARTER]));
  const [adjust, setAdjust] = useState<boolean>(value?.adjust !== false);
  const [paste, setPaste] = useState("");
  const [pasteNote, setPasteNote] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const dragFrom = useRef<number | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  // The dashboard's palette changed underneath (Revert, another editor).
  const lastApplied = useRef<string>(JSON.stringify(value?.colors || null));
  useEffect(() => {
    const incoming = JSON.stringify(value?.colors || null);
    if (incoming !== lastApplied.current && value?.colors?.length) {
      lastApplied.current = incoming;
      setColors(value.colors);
      setAdjust(value.adjust !== false);
      setDrafts({});
    }
  }, [value]);

  const commit = (next: string[], nextAdjust = adjust) => {
    setColors(next);
    setAdjust(nextAdjust);
    if (active && next.length) {
      lastApplied.current = JSON.stringify(next);
      onApply({ kind: "custom", colors: next, adjust: nextAdjust });
    }
  };

  const here = useMemo(() => validateCustomPalette(colors, mode), [colors, mode]);
  const other = useMemo(() => validateCustomPalette(colors, mode === "light" ? "dark" : "light"), [colors, mode]);
  const adjustedHere = here.adjusted.length;
  const adjustedOther = other.adjusted.length;
  const needsAdjusting = adjustedHere > 0 || adjustedOther > 0;
  const count = adjustedHere || adjustedOther;
  const shownMode = adjustedHere ? mode : mode === "light" ? "dark" : "light";
  const shown = adjustedHere ? here : other;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= colors.length || from === to) return;
    const next = [...colors];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setDrafts({});
    commit(next);
  };
  const setAt = (i: number, hex: string) => commit(colors.map((c, j) => (j === i ? hex : c)));

  return (
    <div className="flex flex-col gap-3" data-custom-palette="">
      <ol className="m-0 flex list-none flex-col gap-1.5 p-0" aria-label="Custom palette colours">
        {colors.map((c, i) => {
          const draft = drafts[i];
          const invalid = draft !== undefined && !parseHex(draft);
          return (
            <li
              key={i}
              data-custom-color={i}
              draggable={!disabled}
              onDragStart={(e) => { dragFrom.current = i; e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", c); }}
              onDragOver={(e) => { if (dragFrom.current === null) return; e.preventDefault(); setDropAt(i); }}
              onDragLeave={() => setDropAt((d) => (d === i ? null : d))}
              onDrop={(e) => { e.preventDefault(); const from = dragFrom.current; dragFrom.current = null; setDropAt(null); if (from !== null) move(from, i); }}
              onDragEnd={() => { dragFrom.current = null; setDropAt(null); }}
              className={cn("flex items-center gap-1.5 rounded-ctl border bg-surface px-1.5 py-1", dropAt === i ? "border-brand-ink" : "border-border")}
            >
              <span aria-hidden="true" title="Drag to reorder" className="inline-flex h-7 w-5 shrink-0 cursor-grab items-center justify-center text-faint active:cursor-grabbing"><GripIcon size={14} /></span>
              <span className="w-4 shrink-0 text-center text-caption tabular-nums text-muted">{i + 1}</span>
              <input
                type="color"
                aria-label={`Colour ${i + 1}`}
                value={parseHex(c) || PALETTES[0].light[0]}
                disabled={disabled}
                onChange={(e) => { setDrafts((d) => { const n = { ...d }; delete n[i]; return n; }); setAt(i, e.target.value.toLowerCase()); }}
                className="ui-focus h-7 w-8 shrink-0 cursor-pointer rounded-[6px] border border-border bg-transparent p-0"
              />
              <Input
                aria-label={`Colour ${i + 1} hex code`}
                mono
                maxLength={7}
                disabled={disabled}
                invalid={invalid}
                value={draft ?? c}
                onChange={(e) => {
                  const text = e.target.value;
                  const hex = parseHex(text);
                  setDrafts((d) => ({ ...d, [i]: text }));
                  if (hex) setAt(i, hex);
                }}
                onBlur={() => setDrafts((d) => { const n = { ...d }; delete n[i]; return n; })}
                className="!h-8 min-w-0 flex-1"
              />
              <IconButton size="sm" aria-label={`Move colour ${i + 1} up`} icon={<ArrowUpIcon size={13} />} disabled={disabled || i === 0} onClick={() => move(i, i - 1)} />
              <IconButton size="sm" aria-label={`Move colour ${i + 1} down`} icon={<ArrowDownIcon size={13} />} disabled={disabled || i === colors.length - 1} onClick={() => move(i, i + 1)} />
              <IconButton size="sm" aria-label={`Remove colour ${i + 1}`} icon={<TrashIcon size={13} />} disabled={disabled || colors.length <= 1} onClick={() => { setDrafts({}); commit(colors.filter((_, j) => j !== i)); }} />
            </li>
          );
        })}
      </ol>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="secondary" icon={<PlusIcon size={14} />} disabled={disabled || colors.length >= MAX_CUSTOM} onClick={() => commit([...colors, PALETTES[0].light[colors.length % 10]])} data-custom-add="">
          Add colour
        </Button>
        <span className="text-caption text-muted">{colors.length} of {MAX_CUSTOM} · slot 1 is used first</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="custom-palette-paste" className="text-caption font-medium uppercase tracking-caps text-muted">Paste hex codes</label>
        <Textarea
          id="custom-palette-paste"
          rows={2}
          mono
          disabled={disabled}
          placeholder="#0f5c46, #e4002b, #ffd400 …"
          value={paste}
          onChange={(e) => { setPaste(e.target.value); setPasteNote(null); }}
          data-custom-paste=""
        />
        <div className="flex items-center gap-2">
          <Button
            variant="secondary"
            disabled={disabled || !paste.trim()}
            onClick={() => {
              const parsed = parseColorList(paste);
              if (!parsed.length) { setPasteNote("No hex colours found. Use codes like #0f5c46, separated by commas, spaces or new lines."); return; }
              const total = paste.split(/[\s,;|]+/).filter(Boolean).length;
              setPasteNote(total > parsed.length ? `Used ${parsed.length} colour${parsed.length === 1 ? "" : "s"}; ${total - parsed.length} entr${total - parsed.length === 1 ? "y was" : "ies were"} not a hex colour or past the tenth.` : null);
              setDrafts({});
              setPaste("");
              commit(parsed);
            }}
            data-custom-paste-apply=""
          >
            Replace with pasted colours
          </Button>
          {pasteNote && <span role="status" className="min-w-0 text-caption text-muted">{pasteNote}</span>}
        </div>
      </div>

      {needsAdjusting ? (
        <div className="flex flex-col gap-2 rounded-ctl border border-warning-border bg-warning-fill px-3 py-2.5" data-custom-adjusted={count} role="status">
          <div className="text-ui font-medium text-warning">
            We adjusted {count} colour{count === 1 ? "" : "s"} so they stay distinguishable — see before/after
          </div>
          <div className="flex flex-col gap-1 text-caption text-secondary" data-custom-before-after="">
            {shown.adjusted.map((i) => (
              <div key={i} className="flex items-center gap-2">
                <span className="w-[58px] shrink-0 text-muted">Colour {i + 1}</span>
                <span aria-hidden="true" className="h-4 w-7 rounded-[4px] border border-border" style={{ background: parseHex(colors[i]) || "transparent" }} />
                <span className="font-mono">{parseHex(colors[i]) || colors[i]}</span>
                <span aria-hidden="true" className="text-muted">→</span>
                <span aria-hidden="true" className="h-4 w-7 rounded-[4px] border border-border" style={{ background: shown.fixed[i] }} />
                <span className="font-mono">{shown.fixed[i]}</span>
              </div>
            ))}
            <div className="text-muted">
              {shown.issues.slice(0, 3).map((it) => it.message).join(" ")}
              {adjustedHere && adjustedOther ? " Checked for the light and the dark theme." : ` Shown for the ${shownMode} theme.`}
            </div>
          </div>
          <Switch
            checked={adjust}
            disabled={disabled}
            onChange={(on) => commit(colors, on)}
            label={<span className="text-ui text-text">Use the adjusted colours</span>}
            description={adjust ? "Hue is kept; lightness and saturation move only as far as needed." : "Your colours are used exactly as typed."}
            data-custom-adjust=""
          />
          {!adjust && (
            <span className="self-start" data-custom-warning=""><StatusPill tone="warning" icon="glyph">Some of these colours are hard to tell apart on a chart</StatusPill></span>
          )}
        </div>
      ) : (
        <span className="self-start" data-custom-ok=""><StatusPill tone="good" icon="glyph">These colours stay distinguishable, in the light and the dark theme</StatusPill></span>
      )}

      {!active && (
        <Button variant="primary" disabled={disabled || !colors.length} onClick={() => { lastApplied.current = JSON.stringify(colors); onApply({ kind: "custom", colors, adjust }); }} className="self-start" data-custom-apply="">
          Use this palette
        </Button>
      )}
    </div>
  );
}
