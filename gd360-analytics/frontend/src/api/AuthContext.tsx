import React, { createContext, useContext, useEffect, useState } from "react";
import { api } from "./client";

type User = { id: string; email: string; full_name?: string; company?: string };

type CaptchaChallenge = { captcha_id: string; question: string };

type AuthContextType = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
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

  const login = async (email: string, password: string) => {
    const { data } = await api.post("/auth/login", { email, password });
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
    await api.post("/auth/change-password", {
      current_password: currentPassword,
      new_password: newPassword,
    });
  };

  const logout = () => {
    localStorage.removeItem("gd360_token");
    localStorage.removeItem("gd360_user");
    setUser(null);
  };

  return (
    <AuthContext.Provider
      value={{ user, loading, login, register, getCaptcha, updateProfile, changePassword, logout }}
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
