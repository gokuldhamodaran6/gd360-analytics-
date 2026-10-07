import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { dashboardBuilderApi, workspaceApi, type AppearancePatch, type DashboardBuilderDetail } from "../../api/client";
import {
  DEFAULT_STYLE, STYLE_KEYS, appearanceFromKit, completeAppearance, type AppearanceStyle, type BrandKit, type ColorPin, type DashboardAppearance, type ValueColors,
} from "./appearance";
import { valueKey } from "./chartTheme";

// 2026-10-07 (identity-colour round): the state behind the Appearance
// sheet - one small controller the sheet reads and writes, with two
// sources:
//
//   useDashboardAppearance   a dashboard: every change is applied to the
//       page at once (setDash - the dashboard behind the sheet IS the
//       preview) and saved through PATCH /appearance, debounced, one
//       request in flight at a time, newest state wins. Brand colours and
//       the page background still save through the branding endpoints.
//   useKitAppearance         a workspace brand kit: the same edits, saved
//       with PUT /workspaces/{id}/brand-kit.
//
// Both give "Saving... / Saved / Couldn't save - Retry" and one "Revert
// changes" back to what was there when the sheet opened.

export type SaveState = "idle" | "saving" | "saved" | "error";

export type BrandColors = { primary: string | null; accent: string | null };
export type PageBackground = { style: "default" | "color" | "image"; color: string | null };
type BrandingBody = Partial<{ brand_primary_color: string; brand_accent_color: string; background_style: "default" | "color" | "image"; background_color: string }>;

export type AppearanceController = {
  kind: "dashboard" | "kit";
  appearance: DashboardAppearance;
  canEdit: boolean;
  // Change style fields (optimistic, debounced save).
  patch: (changes: Partial<AppearanceStyle>) => void;
  saveState: SaveState;
  saveError: string | null;
  retry: () => void;
  // Anything changed since begin().
  dirty: boolean;
  // Marks "now" as what Revert goes back to (the sheet calls it on open).
  begin: () => void;
  revert: () => void;
  // The chrome colours (a dashboard's own columns, or the kit's).
  brand: BrandColors;
  setBrand: (changes: Partial<BrandColors>) => void;
  // Dashboard only.
  background?: PageBackground;
  setBackground?: (changes: Partial<PageBackground>) => void;
  pin?: (column: string, value: string, pin: ColorPin | null) => void;
  resetColors?: () => void;
  resetToWorkspace?: () => void;
  workspaceKit?: BrandKit | null;
  workspaceName?: string | null;
};

const DEBOUNCE_MS = 350;

function styleOf(a: DashboardAppearance): AppearanceStyle {
  const out = {} as Record<string, unknown>;
  for (const key of STYLE_KEYS) out[key] = a[key] ?? DEFAULT_STYLE[key];
  return out as AppearanceStyle;
}

function detail(e: any, fallback: string): string {
  const d = e?.response?.data?.detail;
  return typeof d === "string" && d ? d : fallback;
}

// ---- a dashboard ----------------------------------------------------------

export type DashboardAppearanceOptions = {
  dash: DashboardBuilderDetail;
  setDash: Dispatch<SetStateAction<DashboardBuilderDetail | null>>;
  // After "Reset colours": the page runs again so the registry is rebuilt.
  onColorsReset?: () => void;
};

export function useDashboardAppearance({ dash, setDash, onColorsReset }: DashboardAppearanceOptions): AppearanceController {
  const appearance = useMemo(() => completeAppearance(dash.appearance), [dash.appearance]);
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const latest = useRef({ dash, appearance });
  latest.current = { dash, appearance };
  // What still has to reach the server, merged; the request in flight; the
  // last request that failed (Retry sends it again).
  const pending = useRef<AppearancePatch | null>(null);
  const brandPending = useRef<BrandingBody | null>(null);
  const failed = useRef<{ patch: AppearancePatch | null; brand: typeof brandPending.current } | null>(null);
  const inFlight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const snapshot = useRef<{ appearance: DashboardAppearance; brand: BrandColors; background: PageBackground } | null>(null);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }, []);

  const applyLocal = useCallback((fn: (a: DashboardAppearance) => DashboardAppearance) => {
    setDash((d) => (d ? { ...d, appearance: fn(completeAppearance(d.appearance)) } : d));
  }, [setDash]);

  const flush = useCallback(async () => {
    if (inFlight.current) return;
    const patch = pending.current;
    const brand = brandPending.current;
    if (!patch && !brand) return;
    pending.current = null;
    brandPending.current = null;
    inFlight.current = true;
    setSaveState("saving");
    setSaveError(null);
    const id = latest.current.dash.id;
    try {
      // Brand colours first: a dashboard's FIRST brand colour makes the
      // server keep the chart colours it shows (see the branding endpoint).
      if (brand) {
        const updated = await dashboardBuilderApi.updateBranding(id, brand);
        if (alive.current && !pending.current && !brandPending.current && !patch) setDash(updated);
        else if (alive.current) setDash((d) => (d ? { ...d, brand_primary_color: updated.brand_primary_color, brand_accent_color: updated.brand_accent_color, background_style: updated.background_style, background_color: updated.background_color } : d));
      }
      if (patch) {
        const res = await dashboardBuilderApi.updateAppearance(id, patch);
        // The server's word is taken only when nothing newer is waiting -
        // otherwise the optimistic state on screen is the newer one.
        if (alive.current && !pending.current && !brandPending.current) {
          setDash((d) => (d ? { ...d, appearance: res.appearance, workspace_brand_kit: res.workspace_brand_kit, brand_workspace_id: res.brand_workspace_id, brand_workspace_name: res.brand_workspace_name } : d));
        }
      }
      failed.current = null;
      if (alive.current) setSaveState("saved");
    } catch (e: any) {
      failed.current = { patch, brand };
      if (alive.current) {
        setSaveState("error");
        setSaveError(detail(e, "Couldn't save the appearance."));
      }
    } finally {
      inFlight.current = false;
      if (alive.current && (pending.current || brandPending.current) && !failed.current) void flush();
    }
  }, [setDash]);

  const schedule = useCallback((immediate = false) => {
    if (timer.current) clearTimeout(timer.current);
    if (immediate) { void flush(); return; }
    timer.current = setTimeout(() => { timer.current = null; void flush(); }, DEBOUNCE_MS);
  }, [flush]);

  const queue = useCallback((changes: AppearancePatch, immediate = false) => {
    // A reset replaces whatever was waiting; style keys queued after it ride with it.
    pending.current = changes.reset ? { ...changes } : { ...(pending.current || {}), ...changes };
    failed.current = null;
    setDirty(true);
    schedule(immediate);
  }, [schedule]);

  const patch = useCallback((changes: Partial<AppearanceStyle>) => {
    // The first style change of a dashboard that follows its workspace kit
    // (or the defaults) makes it its own: everything it shows now is kept.
    applyLocal((a) => ({ ...a, ...changes, customized: true, source: "dashboard", legacy_brand: false }));
    queue(changes);
  }, [applyLocal, queue]);

  const pin = useCallback((column: string, value: string, next: ColorPin | null) => {
    const key = valueKey(value);
    const current: ValueColors = latest.current.appearance.value_colors || {};
    const col = { ...(current[column] || {}) };
    if (next === null) delete col[key];
    else col[key] = next;
    const value_colors: ValueColors = { ...current };
    if (Object.keys(col).length) value_colors[column] = col;
    else delete value_colors[column];
    latest.current = { ...latest.current, appearance: { ...latest.current.appearance, value_colors } };
    applyLocal((a) => ({ ...a, value_colors }));
    queue({ value_colors }, true);
  }, [applyLocal, queue]);

  const resetColors = useCallback(() => {
    applyLocal((a) => ({ ...a, value_colors: {}, assignments: {}, overflow: [], registry_full: false }));
    pending.current = null;
    queue({ reset: "colors" }, true);
    // The registry is rebuilt by the next run; give the save a moment first.
    setTimeout(() => onColorsReset?.(), 600);
  }, [applyLocal, queue, onColorsReset]);

  const resetToWorkspace = useCallback(() => {
    const kit = latest.current.dash.workspace_brand_kit || null;
    const base = appearanceFromKit(kit);
    applyLocal((a) => ({
      ...a, ...styleOf(base), customized: false, source: kit ? "workspace" : "default", legacy_brand: false,
      brand: { primary: latest.current.dash.brand_primary_color || kit?.brand_primary_color || null, accent: latest.current.dash.brand_accent_color || kit?.brand_accent_color || null },
    }));
    pending.current = null;
    queue({ reset: "workspace" }, true);
  }, [applyLocal, queue]);

  const setBackground = useCallback((changes: Partial<PageBackground>) => {
    const body: BrandingBody = {};
    if (changes.style) body.background_style = changes.style;
    if ("color" in changes) body.background_color = changes.color || "";
    setDash((d) => (d ? { ...d, background_style: changes.style ?? d.background_style, background_color: "color" in changes ? changes.color || null : d.background_color } : d));
    brandPending.current = { ...(brandPending.current || {}), ...body };
    failed.current = null;
    setDirty(true);
    schedule(Boolean(changes.style));
  }, [setDash, schedule]);

  const setBrand = useCallback((changes: Partial<BrandColors>) => {
    const body: BrandingBody = {};
    if ("primary" in changes) body.brand_primary_color = changes.primary || "";
    if ("accent" in changes) body.brand_accent_color = changes.accent || "";
    setDash((d) => {
      if (!d) return d;
      const a = completeAppearance(d.appearance);
      const primary = "primary" in changes ? changes.primary || null : d.brand_primary_color;
      const accent = "accent" in changes ? changes.accent || null : d.brand_accent_color;
      return {
        ...d, brand_primary_color: primary, brand_accent_color: accent,
        // A dashboard branded before this round keeps its single-colour
        // look in the new colour; any other one keeps its chart colours
        // and is its own from now on (the server does the same).
        appearance: a.legacy_brand && primary
          ? { ...a, single_color: primary, brand: { primary, accent } }
          : { ...a, customized: true, source: "dashboard", legacy_brand: false, brand: { primary, accent } },
      };
    });
    brandPending.current = { ...(brandPending.current || {}), ...body };
    failed.current = null;
    setDirty(true);
    schedule();
  }, [setDash, schedule]);

  const begin = useCallback(() => {
    snapshot.current = {
      appearance: latest.current.appearance,
      brand: { primary: latest.current.dash.brand_primary_color, accent: latest.current.dash.brand_accent_color },
      background: { style: latest.current.dash.background_style || "default", color: latest.current.dash.background_color },
    };
    setDirty(false);
    setSaveState("idle");
    setSaveError(null);
  }, []);

  const revert = useCallback(() => {
    const snap = snapshot.current;
    if (!snap) return;
    const now = latest.current;
    const brandChanged = (now.dash.brand_primary_color || null) !== (snap.brand.primary || null) || (now.dash.brand_accent_color || null) !== (snap.brand.accent || null)
      || (now.dash.background_style || "default") !== snap.background.style || (now.dash.background_color || null) !== (snap.background.color || null);
    setDash((d) => (d ? {
      ...d, brand_primary_color: snap.brand.primary, brand_accent_color: snap.brand.accent, background_style: snap.background.style, background_color: snap.background.color,
      // The registry is the server's: what it is now, not what it was.
      appearance: { ...snap.appearance, assignments: completeAppearance(d.appearance).assignments, overflow: completeAppearance(d.appearance).overflow },
    } : d));
    if (brandChanged) brandPending.current = { brand_primary_color: snap.brand.primary || "", brand_accent_color: snap.brand.accent || "", background_style: snap.background.style, background_color: snap.background.color || "" };
    pending.current = snap.appearance.customized
      ? { ...styleOf(snap.appearance), value_colors: snap.appearance.value_colors }
      : { reset: "workspace", value_colors: snap.appearance.value_colors };
    failed.current = null;
    schedule(true);
    setDirty(false);
  }, [setDash, schedule]);

  const retry = useCallback(() => {
    const f = failed.current;
    if (!f) return;
    pending.current = { ...(f.patch || {}), ...(pending.current || {}) };
    if (!Object.keys(pending.current).length) pending.current = null;
    brandPending.current = f.brand || brandPending.current ? { ...(f.brand || {}), ...(brandPending.current || {}) } : null;
    failed.current = null;
    schedule(true);
  }, [schedule]);

  return {
    kind: "dashboard",
    appearance,
    canEdit: Boolean(dash.can_edit),
    patch,
    saveState,
    saveError,
    retry,
    dirty,
    begin,
    revert,
    brand: { primary: dash.brand_primary_color, accent: dash.brand_accent_color },
    setBrand,
    background: { style: dash.background_style || "default", color: dash.background_color },
    setBackground,
    pin,
    resetColors,
    resetToWorkspace,
    workspaceKit: dash.workspace_brand_kit ?? null,
    workspaceName: dash.brand_workspace_name ?? null,
  };
}

// ---- a workspace brand kit --------------------------------------------------

export type KitAppearanceOptions = {
  workspaceId: string | null;
  // The kit as the workspace list already has it (shown at once).
  initial?: BrandKit | null;
  onSaved?: (kit: BrandKit | null) => void;
};

export function useKitAppearance({ workspaceId, initial = null, onSaved }: KitAppearanceOptions): AppearanceController & { loading: boolean; hasKit: boolean; clear: () => void } {
  const [kit, setKit] = useState<BrandKit | null>(initial);
  const [canEdit, setCanEdit] = useState(false);
  const [loading, setLoading] = useState(Boolean(workspaceId));
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveError, setSaveError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const kitRef = useRef(kit);
  kitRef.current = kit;
  const snapshot = useRef<BrandKit | null>(initial);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(0);
  const alive = useRef(true);
  useEffect(() => () => { alive.current = false; if (timer.current) clearTimeout(timer.current); }, []);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    workspaceApi
      .getBrandKit(workspaceId)
      .then((res) => {
        if (cancelled) return;
        setKit(res.brand_kit);
        snapshot.current = res.brand_kit;
        setCanEdit(res.can_edit);
      })
      .catch(() => undefined)
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  const save = useCallback(async () => {
    if (!workspaceId) return;
    const mine = ++seq.current;
    setSaveState("saving");
    setSaveError(null);
    try {
      const res = await workspaceApi.setBrandKit(workspaceId, kitRef.current);
      if (!alive.current || mine !== seq.current) return;
      setSaveState("saved");
      onSaved?.(res.brand_kit);
    } catch (e: any) {
      if (!alive.current || mine !== seq.current) return;
      setSaveState("error");
      setSaveError(detail(e, "Couldn't save the brand kit."));
    }
  }, [workspaceId, onSaved]);

  const schedule = useCallback((immediate = false) => {
    if (timer.current) clearTimeout(timer.current);
    if (immediate) { void save(); return; }
    timer.current = setTimeout(() => { timer.current = null; void save(); }, DEBOUNCE_MS);
  }, [save]);

  const update = useCallback((next: BrandKit | null, immediate = false) => {
    kitRef.current = next;
    setKit(next);
    setDirty(true);
    schedule(immediate);
  }, [schedule]);

  const appearance = useMemo(() => appearanceFromKit(kit), [kit]);
  return {
    kind: "kit",
    appearance,
    canEdit,
    loading,
    hasKit: kit !== null,
    patch: (changes) => update({ ...styleOf(appearanceFromKit(kitRef.current)), brand_primary_color: kitRef.current?.brand_primary_color ?? null, brand_accent_color: kitRef.current?.brand_accent_color ?? null, ...changes }),
    saveState,
    saveError,
    retry: () => schedule(true),
    dirty,
    begin: () => { snapshot.current = kitRef.current; setDirty(false); setSaveState("idle"); setSaveError(null); },
    revert: () => { update(snapshot.current, true); setDirty(false); },
    brand: { primary: kit?.brand_primary_color ?? null, accent: kit?.brand_accent_color ?? null },
    setBrand: (changes) => update({
      ...styleOf(appearanceFromKit(kitRef.current)),
      brand_primary_color: "primary" in changes ? changes.primary || null : kitRef.current?.brand_primary_color ?? null,
      brand_accent_color: "accent" in changes ? changes.accent || null : kitRef.current?.brand_accent_color ?? null,
    }),
    clear: () => update(null, true),
  };
}
