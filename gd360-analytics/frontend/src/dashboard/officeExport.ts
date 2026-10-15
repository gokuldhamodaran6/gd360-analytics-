// 2026-10-14 (R47): Excel / PowerPoint of a dashboard page, built by the backend (routers/v2.py) from the
// same rows the page shows. Fetched with the session token, then saved from a blob.
import { api } from "../api/client";

export async function downloadOffice(dashboardId: string, pageId: string | undefined, kind: "xlsx" | "pptx", theme: "light" | "dark" = "light"): Promise<void> {
  const res = await api.get(`/v2/dashboards/${dashboardId}/export.${kind}`, { params: { page_id: pageId || undefined, theme }, responseType: "blob" });
  const cd = String(res.headers?.["content-disposition"] || "");
  const m = cd.match(/filename="?([^";]+)"?/);
  const name = m ? m[1] : `dashboard.${kind}`;
  const url = URL.createObjectURL(res.data as Blob);
  const a = document.createElement("a");
  a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
