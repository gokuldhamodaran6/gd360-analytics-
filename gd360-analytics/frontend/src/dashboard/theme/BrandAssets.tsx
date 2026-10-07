import { useRef, useState } from "react";
import { dashboardBuilderApi, type DashboardBuilderDetail } from "../../api/client";
import { Button, Field, SegmentedControl } from "../../ui";
import { ColorField } from "./AppearanceSheet";
import { PAGE } from "./palettes";
import type { AppearanceController, PageBackground } from "./useAppearanceEditor";

// 2026-10-07 (identity-colour round): the dashboard-only half of the
// Appearance sheet's Brand section - the logo and the page background.
// These are the features the old "Branding" panel had, on the same
// endpoints (POST/DELETE .../branding/logo, .../branding/background,
// PATCH .../branding), re-housed with the kit's controls. The background
// style and colour go through the sheet's controller (so "Revert changes"
// covers them); an uploaded image is saved the moment it is picked.

export type BrandAssetsProps = {
  dash: DashboardBuilderDetail;
  controller: AppearanceController;
  onChange: (d: DashboardBuilderDetail) => void;
  logoUrl: string | null;
  backgroundImageUrl: string | null;
  // After an upload or a removal: refetch the image.
  onAssetChanged: () => void;
};

export function BrandAssets({ dash, controller, onChange, logoUrl, backgroundImageUrl, onAssetChanged }: BrandAssetsProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logoInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const disabled = !controller.canEdit || busy;
  const background = controller.background || { style: "default" as const, color: null };

  const run = async (fn: () => Promise<DashboardBuilderDetail>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await fn());
      onAssetChanged();
    } catch (e: any) {
      const d = e?.response?.data?.detail;
      setError(typeof d === "string" && d ? d : "Couldn't update the image. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  const pick = (kind: "logo" | "background") => (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    void run(() => (kind === "logo" ? dashboardBuilderApi.uploadLogo(dash.id, file) : dashboardBuilderApi.uploadBackground(dash.id, file)));
  };

  return (
    <div className="flex flex-col gap-6" data-brand-assets="">
      {error && <div role="alert" className="rounded-ctl border border-danger-border bg-danger-fill px-3 py-2 text-caption text-danger">{error}</div>}
      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-ui font-semibold text-text">Logo</h3>
          <p className="text-caption text-muted">Shown in the dashboard's header and on the published link. PNG, JPEG or WEBP, up to 2 MB.</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden rounded-ctl border border-border bg-subtle" data-logo-preview="">
            {logoUrl ? <img src={logoUrl} alt="" className="h-full w-full object-contain" /> : <span className="text-[10px] text-muted">None</span>}
          </div>
          <Button variant="secondary" disabled={disabled} loading={busy} onClick={() => logoInput.current?.click()} data-logo-upload="">{dash.has_logo ? "Replace" : "Upload"}</Button>
          {dash.has_logo && <Button variant="ghost" disabled={disabled} onClick={() => run(() => dashboardBuilderApi.removeLogo(dash.id))}>Remove</Button>}
          <input ref={logoInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pick("logo")} aria-label="Logo file" />
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-ui font-semibold text-text">Page background</h3>
          <p className="text-caption text-muted">Behind the blocks. Charts stay on their own card surface.</p>
        </div>
        <SegmentedControl<PageBackground["style"]>
          ariaLabel="Page background"
          fullWidth
          disabled={disabled}
          value={background.style}
          onChange={(v) => controller.setBackground?.({ style: v })}
          options={[{ value: "default", label: "Default" }, { value: "color", label: "Colour" }, { value: "image", label: "Image" }]}
        />
        {background.style === "color" && (
          <Field label="Background colour">
            <ColorField label="Page background colour" value={background.color} fallback={PAGE.light} disabled={disabled} onChange={(hex) => controller.setBackground?.({ color: hex })} />
          </Field>
        )}
        {background.style === "image" && (
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-14 shrink-0 items-center justify-center overflow-hidden rounded-ctl border border-border bg-subtle">
              {backgroundImageUrl ? <img src={backgroundImageUrl} alt="" className="h-full w-full object-cover" /> : <span className="text-[10px] text-muted">None</span>}
            </div>
            <Button variant="secondary" disabled={disabled} loading={busy} onClick={() => bgInput.current?.click()}>{dash.has_background_image ? "Replace" : "Upload"}</Button>
            {dash.has_background_image && <Button variant="ghost" disabled={disabled} onClick={() => run(() => dashboardBuilderApi.removeBackground(dash.id))}>Remove</Button>}
            <input ref={bgInput} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={pick("background")} aria-label="Background image file" />
          </div>
        )}
        <p className="text-caption text-muted">An uploaded image is saved as soon as it is picked; "Revert changes" does not remove it.</p>
      </div>
    </div>
  );
}
