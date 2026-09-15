import axios from "axios";

export const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8000";

export const api = axios.create({ baseURL: API_URL });

api.interceptors.request.use((config) => {
  const token = localStorage.getItem("gd360_token");
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (res) => res,
  (err) => {
    // A 401 on the login call itself just means wrong email/password -
    // that should show an error on the login form, not bounce the page
    // away before the person can read it. Only treat a 401 on some other,
    // already-authenticated call as an expired session.
    const requestUrl: string = err?.config?.url || "";
    const isLoginAttempt = requestUrl.includes("/auth/login") || requestUrl.includes("/auth/register");
    if (err?.response?.status === 401 && !isLoginAttempt) {
      localStorage.removeItem("gd360_token");
      localStorage.removeItem("gd360_user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

export type AdminStats = {
  total_users: number;
  new_users_today: number;
  new_users_7d: number;
  total_prompts: number;
  prompts_today: number;
  prompts_7d: number;
  total_datasources: number;
  total_dashboards: number;
};

export type AdminUserRow = {
  id: string;
  email: string;
  full_name: string | null;
  company: string | null;
  created_at: string;
  prompt_count: number;
  last_prompt_at: string | null;
};

export type AdminUsagePoint = { day: string; count: number };

export const adminApi = {
  getStats: () => api.get<AdminStats>("/admin/stats").then((r) => r.data),
  getUsers: () => api.get<AdminUserRow[]>("/admin/users").then((r) => r.data),
  getUsageTimeseries: (days = 14) =>
    api.get<AdminUsagePoint[]>(`/admin/usage-timeseries?days=${days}`).then((r) => r.data),
};

export type DataVersion = "auto" | "original" | "cleaned";

export type CleaningLogEntry = {
  prompt: string;
  summary: string | null;
  rows_before: number | null;
  rows_after: number | null;
  nulls_before: number | null;
  nulls_after: number | null;
  created_at: string;
};

export type DataPreview = {
  columns: string[];
  dtypes: Record<string, string>;
  rows: Record<string, any>[];
  total_rows: number;
  offset: number;
  limit: number;
  has_cleaned_version: boolean;
  cleaned_updated_at: string | null;
  cleaning_log: CleaningLogEntry[];
};

export const datasourceApi = {
  preview: (id: string, version: DataVersion = "auto", limit = 25, offset = 0) =>
    api
      .get<DataPreview>(`/datasources/${id}/preview`, { params: { version, limit, offset } })
      .then((r) => r.data),

  resetCleaning: (id: string) => api.post(`/datasources/${id}/reset-cleaning`),

  downloadExport: async (id: string, version: DataVersion, format: "csv" | "xlsx") => {
    const res = await api.get(`/datasources/${id}/export`, {
      params: { version, export_format: format },
      responseType: "blob",
    });
    const disposition: string = res.headers["content-disposition"] || "";
    const match = disposition.match(/filename="?([^"]+)"?/);
    const filename = match ? match[1] : `data.${format}`;
    const blob = new Blob([res.data]);
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);
  },
};
