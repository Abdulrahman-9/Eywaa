import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { api, setUnauthorizedHandler, tokenStore } from './api';
import type { Role } from './roles';

export interface User {
  id: string;
  username: string;
  fullName: string;
  role: Role;
  mustChangePassword?: boolean;
  totpEnabled?: boolean;
  totpRecommended?: boolean;
  /** دوره مُلزَم بالتحقق بعاملين في هذا النشر: لا يفتح له الخادم شيئاً حتى يفعّله. */
  totpRequired?: boolean;
}

interface AuthState {
  user: User | null;
  loading: boolean;
  login: (username: string, password: string, code?: string) => Promise<void>;
  refresh: () => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(() => !!tokenStore.get());
  const queryClient = useQueryClient();

  const logout = useCallback(() => {
    tokenStore.set(null);
    setUser(null);
    queryClient.clear();
  }, [queryClient]);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    if (!tokenStore.get()) return;
    api<User>('/auth/me').then(setUser).catch(() => {}).finally(() => setLoading(false));
  }, [logout]);

  const refresh = useCallback(async () => { setUser(await api<User>('/auth/me')); }, []);

  const login = useCallback(async (username: string, password: string, code?: string) => {
    const res = await api<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { username, password, code: code || undefined } });
    tokenStore.set(res.token);
    setUser(res.user);
    await refresh();
  }, [refresh]);

  const value = useMemo(() => ({ user, loading, login, logout, refresh }), [user, loading, login, logout, refresh]);
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside AuthProvider');
  return ctx;
}
