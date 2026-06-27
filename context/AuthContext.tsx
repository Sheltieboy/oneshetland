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
import { registerPushToken, clearPushToken } from '@/lib/notifications';

interface AuthContextType {
  session: Session | null;
  profile: Profile | null;
  loading: boolean;
  /**
   * Driver is a CAPABILITY, not an identity. It comes from
   * driver_profiles.driver_status — NOT profiles.role. A normal user (role
   * 'customer') can also be a driver. `null` = never applied / no driver row.
   */
  driverStatus: string | null;
  /** True when the user is an approved driver (can create runs, take requests). */
  isDriver: boolean;
  /** True once the user has applied (pending/approved/rejected/suspended) — i.e. the Driver area is relevant to them. */
  hasAppliedToDrive: boolean;
  signIn: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    phone?: string,
    marketingOptIn?: boolean,
    next?: string,
  ) => Promise<{ error: string | null }>;
  signOut: () => Promise<void>;
  refreshProfile: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function AuthProvider({ children }: PropsWithChildren) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [driverStatus, setDriverStatus] = useState<string | null>(null);
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
        setDriverStatus(null);
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

      // Driver-ness is a capability, read from driver_profiles — independent of
      // profiles.role. No row = never applied. Non-fatal: a failure here just
      // means no driver area, never blocks the rest of the app.
      const { data: dp } = await supabase
        .from('driver_profiles')
        .select('driver_status')
        .eq('id', userId)
        .maybeSingle();
      setDriverStatus((dp?.driver_status as string | undefined) ?? null);
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

  async function signUp(email: string, password: string, fullName: string, phone?: string, marketingOptIn = false, next?: string) {
    // Carry the return-to path through the confirmation deep link so a user who
    // signed up mid-action lands back where they were after confirming.
    const emailRedirectTo = next
      ? `oneshetland-fetch://auth/confirm?next=${encodeURIComponent(next)}`
      : 'oneshetland-fetch://auth/confirm';
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Marketing consent is captured here so it survives email confirmation
        // (there's no session immediately after sign-up). Terms/privacy/age are
        // implied by the on-screen agreement and logged best-effort below.
        data: { full_name: fullName, marketing_opt_in: marketingOptIn },
        // Deep link back into the app after email confirmation
        // Requires "oneshetland-fetch://**" in Supabase → Auth → URL Configuration
        emailRedirectTo,
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
    // Clear this device's push token first (while we still have the session),
    // so the next user on a shared device doesn't inherit our notifications.
    const userId = session?.user.id;
    if (userId) await clearPushToken(userId);
    await supabase.auth.signOut();
  }

  const isDriver = driverStatus === 'approved';
  const hasAppliedToDrive = driverStatus != null && driverStatus !== 'not_applied';

  return (
    <AuthContext.Provider
      value={{
        session, profile, loading,
        driverStatus, isDriver, hasAppliedToDrive,
        signIn, signUp, signOut, refreshProfile,
      }}
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
