// 2026-10-10: Mission Control data access. Thin wrappers over the shared
// axios client (it already adds the sign-in token and normalises errors).
import { useCallback, useEffect, useRef, useState } from "react";
import { api, API_URL, errorDetailText } from "../api/client";

export const MC = "/admin/v2";

export function errText(e: any, fallback = "Something went wrong."): string {
  return errorDetailText(e?.response?.data?.detail) || e?.message || fallback;
}

export async function mcGet<T = any>(path: string): Promise<T> {
  const { data } = await api.get(MC + path);
  return data;
}
export async function mcPost<T = any>(path: string, body?: any): Promise<T> {
  const { data } = await api.post(MC + path, body ?? {});
  return data;
}
export async function mcPut<T = any>(path: string, body?: any): Promise<T> {
  const { data } = await api.put(MC + path, body ?? {});
  return data;
}
export async function mcPatch<T = any>(path: string, body?: any): Promise<T> {
  const { data } = await api.patch(MC + path, body ?? {});
  return data;
}
export async function mcDelete<T = any>(path: string): Promise<T> {
  const { data } = await api.delete(MC + path);
  return data;
}

/** Downloads a file from an authenticated endpoint (CSV / JSON exports). */
export async function mcDownload(path: string, filename: string) {
  const { data } = await api.get(MC + path, { responseType: "blob" });
  const url = URL.createObjectURL(data);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** GET with loading / error / reload. Re-fetches when `path` changes. */
export function useMC<T = any>(path: string | null) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    setError("");
    try {
      const d = await mcGet<T>(path);
      if (n === seq.current) setData(d);
    } catch (e: any) {
      if (n === seq.current) setError(errText(e, "Couldn't load this."));
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

export { API_URL };
