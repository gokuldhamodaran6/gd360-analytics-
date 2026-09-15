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
