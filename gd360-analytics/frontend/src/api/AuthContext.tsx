import React, { createContext, useContext, useEffect, useState } from "react";
import { api } from "./client";

type User = { id: string; email: string; full_name?: string; company?: string };

type CaptchaChallenge = { captcha_id: string; question: string };

// 2026-10-10 (round 19): a password sign-in can need a second step (an
// authenticator code) - login() then resolves with the short-lived token
// for completeMfa() instead of signing in.
export type LoginResult = { mfaRequired: boolean; mfaToken?: string };

type AuthContextType = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  completeMfa: (mfaToken: string, code: string) => Promise<void>;
  register: (
    email: string,
    password: string,
    captchaId: string,
    captchaAnswer: string,
    full_name?: string,
    company?: string
  ) => Promise<void>;
  getCaptcha: () => Promise<CaptchaChallenge>;
  updateProfile: (full_name: string, company: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const stored = localStorage.getItem("gd360_user");
    if (stored) setUser(JSON.parse(stored));
    setLoading(false);
  }, []);

  const persist = (token: string, user: User) => {
    localStorage.setItem("gd360_token", token);
    localStorage.setItem("gd360_user", JSON.stringify(user));
    setUser(user);
  };

  const login = async (email: string, password: string): Promise<LoginResult> => {
    const { data } = await api.post("/auth/login", { email, password });
    if (data.mfa_required) return { mfaRequired: true, mfaToken: data.mfa_token };
    persist(data.access_token, data.user);
    return { mfaRequired: false };
  };

  const completeMfa = async (mfaToken: string, code: string) => {
    const { data } = await api.post("/auth/login/mfa", { mfa_token: mfaToken, code });
    persist(data.access_token, data.user);
  };

  const getCaptcha = async (): Promise<CaptchaChallenge> => {
    const { data } = await api.get("/auth/captcha");
    return data;
  };

  const register = async (
    email: string,
    password: string,
    captchaId: string,
    captchaAnswer: string,
    full_name?: string,
    company?: string
  ) => {
    const { data } = await api.post("/auth/register", {
      email,
      password,
      full_name,
      company,
      captcha_id: captchaId,
      captcha_answer: captchaAnswer,
    });
    persist(data.access_token, data.user);
  };

  const updateProfile = async (full_name: string, company: string) => {
    const { data } = await api.patch("/auth/profile", { full_name, company });
    const merged = { ...(user || {}), ...data };
    localStorage.setItem("gd360_user", JSON.stringify(merged));
    setUser(merged);
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    const { data } = await api.post("/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
    // 2026-10-10 (round 19): changing the password signs out every other
    // session; this one carries on with the new token the server returns.
    if (data?.access_token) localStorage.setItem("gd360_token", data.access_token);
  };

  const logout = () => {
    localStorage.removeItem("gd360_token");
    localStorage.removeItem("gd360_user");
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, login, completeMfa, register, getCaptcha, updateProfile, changePassword, logout }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
