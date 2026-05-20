import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  PropsWithChildren,
} from 'react';
import { Session } from '@supabase/supabase-js';
import { supabase } from '@/lib/supabase';
import { Profile } from '@/types/database';
import { registerPushToken } from '@/lib/notifications';

interface AuthContextType {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    phone?: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      if (session) {
        fetchProfile(session.user.id);
      } else {
        setLoading(false);
      }
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
      if (session) {
        fetchProfile(session.user.id);
      } else {
        setProfile(null);
        setLoading(false);
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  async function fetchProfile(userId: string) {
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        console.error('[OneShetland] Profile fetch error:', error.message);
      } else {
        setProfile(data as Profile);
        // Register / refresh push token each time profile loads
        registerPushToken(userId).catch(() => {/* non-fatal */});
      }
    } catch (err) {
      console.error('[OneShetland] Profile fetch exception:', err);
    } finally {
      setLoading(false);
    }
  }

  async function refreshProfile() {
    if (session?.user.id) {
      await fetchProfile(session.user.id);
    }
  }

  async function signIn(email: string, password: string) {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }

  async function signUp(email: string, password: string, fullName: string, phone?: string) {
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        data: { full_name: fullName },
        // Deep link back into the app after email confirmation
        // Requires "oneshetland-fetch://**" in Supabase → Auth → URL Configuration
        emailRedirectTo: 'oneshetland-fetch://auth/confirm',
      },
    });

    // If sign-up succeeded and a phone was provided, update the profile row
    // (the trigger creates it immediately, so this update should succeed)
    if (!error && data.user && phone?.trim()) {
      await supabase
        .from('profiles')
        .update({ phone: phone.trim() })
        .eq('id', data.user.id);
    }

    return { error: error?.message ?? null };
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  return (
    <AuthContext.Provider
      value={{ session, profile, loading, signIn, signUp, signOut, refreshProfile }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within AuthProvider');
  return context;
}
