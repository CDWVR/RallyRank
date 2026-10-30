import React, { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useAuth } from '@/context/AuthContext';
import BrandMark from '@/components/BrandMark';
import {
  authCallbackUrl,
  isEmailConfirmed,
  isEmailNotConfirmedError,
  sanitizeAppPath,
  savePendingAuth,
  savePostAuthRedirect,
} from '@/lib/authHelpers';
import { cn } from '@/lib/utils';


const AuthPage: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [params] = useSearchParams();
  const { user, isLoading } = useAuth();
  const [tab, setTab] = useState(params.get('mode') === 'signup' ? 'signup' : 'login');

  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);

  const redirectTo = useMemo(() => {
    const fromState =
      typeof (location.state as { from?: string } | null)?.from === 'string'
        ? (location.state as { from: string }).from
        : null;
    return sanitizeAppPath(params.get('redirect') || fromState, '/onboarding');
  }, [params, location.state]);

  useEffect(() => {
    savePostAuthRedirect(redirectTo);
  }, [redirectTo]);

  useEffect(() => {
    if (isLoading || !user) return;
    if (!isEmailConfirmed(user)) {
      navigate(
        `/auth/verify-email?email=${encodeURIComponent(user.email || '')}&redirect=${encodeURIComponent(redirectTo)}`,
        { replace: true }
      );
      return;
    }
    navigate(redirectTo, { replace: true });
  }, [user, isLoading, navigate, redirectTo]);

  const handleGoogle = async () => {
    setGoogleLoading(true);
    savePostAuthRedirect(redirectTo);
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: {
        redirectTo: authCallbackUrl(),
        queryParams: {
          access_type: 'offline',
          prompt: 'consent',
        },
      },
    });
    if (error) {
      setGoogleLoading(false);
      toast.error(error.message);
    }
  };

  const handleSignUp = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!firstName.trim() || !lastName.trim()) {
      toast.error('Please enter your first and last name');
      return;
    }
    if (password !== confirmPassword) {
      toast.error('Passwords do not match');
      return;
    }
    if (password.length < 6) {
      toast.error('Password must be at least 6 characters');
      return;
    }
    if (!phone.trim()) {
      toast.error('Please enter your phone number');
      return;
    }

    setLoading(true);
    const { data, error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
        emailRedirectTo: authCallbackUrl(),
        data: {
          first_name: firstName.trim(),
          last_name: lastName.trim(),
          phone: phone.trim(),
          username: `${firstName.trim()} ${lastName.trim()}`.trim(),
        },
      },
    });
    setLoading(false);

    if (error) {
      toast.error(error.message);
      return;
    }

    savePendingAuth(email.trim());
    savePostAuthRedirect(redirectTo);

    if (data.session && isEmailConfirmed(data.user)) {
      toast.success('Welcome to RallyRank');
      navigate(redirectTo);
      return;
    }

    toast.success('Check your inbox to verify your email');
    navigate(
      `/auth/verify-email?email=${encodeURIComponent(email.trim())}&redirect=${encodeURIComponent(redirectTo)}`
    );
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { data, error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);

    if (error) {
      if (isEmailNotConfirmedError(error.message)) {
        savePendingAuth(email.trim());
        savePostAuthRedirect(redirectTo);
        toast.message('Please verify your email to continue');
        navigate(
          `/auth/verify-email?email=${encodeURIComponent(email.trim())}&redirect=${encodeURIComponent(redirectTo)}`
        );
        return;
      }
      toast.error(error.message);
      return;
    }

    toast.success('Welcome back');
    navigate(redirectTo);
  };

  return (
    <div className="flex min-h-screen flex-col lg:flex-row">
      <aside
        className="relative flex flex-col justify-between px-8 py-10 text-white lg:w-[42%] lg:px-12 lg:py-14"
        style={{
          background:
            'linear-gradient(160deg, #0c241a 0%, #165a3d 50%, #1f6b4a 100%)',
        }}
      >
        <Link to="/" className="group flex items-center gap-2.5">
          <BrandMark mood="auth" inverted className="h-8 w-8" />
          <span className="font-display text-xl font-bold">RallyRank</span>
        </Link>
        <div className="mt-10 max-w-sm lg:mt-0">
          <h1 className="font-display text-3xl font-bold leading-tight md:text-4xl">
            Your club. Fair teams. Clear rankings.
          </h1>
          <p className="mt-4 text-base text-white/85">
            Sign in to balance tonight’s session and keep the ladder honest.
          </p>
        </div>
        <p className="mt-10 hidden text-sm text-white/55 lg:block">
          Badminton club ladders
        </p>
      </aside>

      <main className="flex flex-1 items-center justify-center bg-[#f4f6f3] px-4 py-10">
        <div className="w-full max-w-lg">
          <div className="surface-panel p-6 md:p-8">
            <h2 className="font-display text-2xl font-bold text-ink">Welcome</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Continue with Google or email
            </p>

            <Button
              type="button"
              variant="outline"
              className="mt-6 h-11 w-full border-[#d5ddd7] bg-white hover:bg-[#eef2ee]"
              onClick={handleGoogle}
              disabled={googleLoading}
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" aria-hidden>
                <path
                  fill="#4285F4"
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
                />
                <path
                  fill="#34A853"
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                />
                <path
                  fill="#FBBC05"
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                />
                <path
                  fill="#EA4335"
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                />
              </svg>
              {googleLoading ? 'Redirecting…' : 'Continue with Google'}
            </Button>

            <div className="my-6 flex items-center gap-3">
              <div className="h-px flex-1 bg-[#d5ddd7]" />
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                or email
              </span>
              <div className="h-px flex-1 bg-[#d5ddd7]" />
            </div>

            <Tabs
              value={tab}
              onValueChange={(value) => {
                setTab(value);
                const next = new URLSearchParams(params);
                if (value === 'signup') next.set('mode', 'signup');
                else next.delete('mode');
                navigate(`/auth?${next.toString()}`, { replace: true });
              }}
            >
              <TabsList className="relative mb-6 grid w-full grid-cols-2 overflow-hidden">
                <span
                  aria-hidden
                  className={cn(
                    'pointer-events-none absolute inset-y-1 left-1 w-[calc(50%-0.25rem)] rounded-sm bg-background shadow-sm',
                    'transition-transform duration-300 ease-out',
                    tab === 'signup' ? 'translate-x-full' : 'translate-x-0'
                  )}
                />
                <TabsTrigger
                  value="login"
                  className="relative z-10 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  Sign in
                </TabsTrigger>
                <TabsTrigger
                  value="signup"
                  className="relative z-10 data-[state=active]:bg-transparent data-[state=active]:shadow-none"
                >
                  Sign up
                </TabsTrigger>
              </TabsList>

              <TabsContent value="login" forceMount className="data-[state=inactive]:hidden">
                <form onSubmit={handleSignIn} className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input
                      id="email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="password">Password</Label>
                    <Input
                      id="password"
                      type="password"
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>
                  <Button type="submit" className="h-11 w-full" disabled={loading}>
                    {loading ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>
              </TabsContent>

              <TabsContent value="signup" forceMount className="data-[state=inactive]:hidden">
                <form onSubmit={handleSignUp} className="space-y-4">
                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="space-y-2">
                      <Label htmlFor="first-name">First name</Label>
                      <Input
                        id="first-name"
                        autoComplete="given-name"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                        required
                        className="h-11 transition-[border-color,box-shadow] duration-300"
                      />
                    </div>
                    <div className="space-y-2">
                      <Label htmlFor="last-name">Last name</Label>
                      <Input
                        id="last-name"
                        autoComplete="family-name"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                        required
                        className="h-11 transition-[border-color,box-shadow] duration-300"
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="signup-email">Email</Label>
                    <Input
                      id="signup-email"
                      type="email"
                      autoComplete="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone number</Label>
                    <Input
                      id="phone"
                      type="tel"
                      autoComplete="tel"
                      inputMode="tel"
                      placeholder="+91 98765 43210"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      required
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="signup-password">Password</Label>
                    <Input
                      id="signup-password"
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      minLength={6}
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="confirm-password">Re-enter password</Label>
                    <Input
                      id="confirm-password"
                      type="password"
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      required
                      minLength={6}
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>

                  <Button type="submit" className="h-11 w-full" disabled={loading}>
                    {loading ? 'Creating…' : 'Create account'}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    We’ll email you a verification link before you can enter your club.
                  </p>
                </form>
              </TabsContent>
            </Tabs>
          </div>
        </div>
      </main>
    </div>
  );
};

export default AuthPage;
