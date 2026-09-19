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
import { emailConfirmationRedirectTo } from '@/lib/auth-redirect';
import { withDeadline, TIMED_OUT } from '@/lib/with-deadline';
import { logAuthStage } from '@/lib/auth-diagnostics';
import { classifyAuthError } from '@/lib/auth-stage';

const SIGN_IN_TIMEOUT_MS = 30_000;

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
  /** `timedOut` is set only when the request outlived SIGN_IN_TIMEOUT_MS. */
  signIn: (email: string, password: string, captchaToken: string) => Promise<{ error: string | null; timedOut?: boolean }>;
  signUp: (
    email: string,
    password: string,
    fullName: string,
    captchaToken: string,
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
    const bootstrapStartedAt = Date.now();
    logAuthStage('session_bootstrap_started', { phase: 'launch' });
    supabase.auth.getSession().then(({ data: { session } }) => {
      logAuthStage('session_bootstrap_completed', {
        phase: 'launch',
        reason: session ? 'restored' : 'no_session',
        elapsedMs: Date.now() - bootstrapStartedAt,
      });
      setSession(session);
      if (session) {
        fetchProfile(session.user.id);
      } else {
        setLoading(false);
      }
    }).catch((err) => {
      // A failed storage read must read as "signed out", never as "still
      // loading" — `loading` gates the whole navigator.
      console.error('[OneShetland] getSession failed:', err);
      logAuthStage('session_bootstrap_completed', {
        phase: 'launch',
        reason: 'error',
        elapsedMs: Date.now() - bootstrapStartedAt,
      });
      setLoading(false);
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
    const startedAt = Date.now();
    logAuthStage('session_bootstrap_started', { phase: 'profile' });
    let bootstrapReason: 'ok' | 'error' = 'ok';
    try {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', userId)
        .single();

      if (error) {
        bootstrapReason = 'error';
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
      bootstrapReason = 'error';
      console.error('[OneShetland] Profile fetch exception:', err);
    } finally {
      logAuthStage('session_bootstrap_completed', {
        phase: 'profile',
        reason: bootstrapReason,
        elapsedMs: Date.now() - startedAt,
      });
      setLoading(false);
    }
  }

  async function refreshProfile() {
    if (session?.user.id) {
      await fetchProfile(session.user.id);
    }
  }

  async function signIn(email: string, password: string, captchaToken: string) {
    // Required once Supabase Auth's CAPTCHA enforcement is turned on. The
    // caller is responsible for obtaining a fresh, unused token before
    // calling signIn — there is no path here that calls the API without one.
    //
    // Bounded: supabase-js sets no request timeout, so a stalled connection
    // would otherwise hold the caller's spinner until the OS gives up.
    const startedAt = Date.now();
    logAuthStage('supabase_signin_started');
    try {
      const result = await withDeadline(
        supabase.auth.signInWithPassword({
          email,
          password,
          options: { captchaToken },
        }),
        SIGN_IN_TIMEOUT_MS,
      );
      if (result === TIMED_OUT) {
        logAuthStage('auth_timed_out', { reason: 'supabase_deadline', elapsedMs: Date.now() - startedAt });
        return {
          error: 'Sign-in is taking too long. Check your connection and try again.',
          timedOut: true,
        };
      }
      // The request came back. Only the bucket is logged, never the message.
      const reason = classifyAuthError(result.error?.message);
      logAuthStage('supabase_signin_completed', { reason, elapsedMs: Date.now() - startedAt });
      if (reason !== 'ok') logAuthStage('auth_failed', { reason, elapsedMs: Date.now() - startedAt });
      return { error: result.error?.message ?? null };
    } catch (err) {
      logAuthStage('auth_failed', { reason: 'exception', elapsedMs: Date.now() - startedAt });
      return { error: err instanceof Error ? err.message : 'Sign-in failed. Please try again.' };
    }
  }

  async function signUp(email: string, password: string, fullName: string, captchaToken: string, phone?: string, marketingOptIn = false, next?: string) {
    const emailRedirectTo = emailConfirmationRedirectTo(next);
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        // Required once Supabase Auth's CAPTCHA enforcement is turned on.
        // The caller is responsible for obtaining a fresh, unused token before
        // calling signUp — there is no path here that calls the API without one.
        captchaToken,
        // Marketing consent is captured here so it survives email confirmation
        // (there's no session immediately after sign-up). Terms/privacy/age
        // are only ever recorded once the required consent checkbox on this
        // screen has actually been ticked — see handleSignUp in sign-up.tsx.
        data: { full_name: fullName, marketing_opt_in: marketingOptIn, signup_platform: 'app' },
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
