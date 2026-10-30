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
import { sanitizeAppPath, savePostAuthRedirect } from '@/lib/authHelpers';
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
    navigate(redirectTo, { replace: true });
  }, [user, isLoading, navigate, redirectTo]);

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
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters');
      return;
    }
    if (!phone.trim()) {
      toast.error('Please enter your phone number');
      return;
    }

    setLoading(true);
    const { error } = await supabase.auth.signUp({
      email: email.trim(),
      password,
      options: {
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

    toast.success('Welcome to RallyRank');
    navigate(redirectTo);
  };

  const handleSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    setLoading(false);

    if (error) {
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
              Sign in or create an account with your email
            </p>

            <Tabs
              className="mt-6"
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
                      minLength={8}
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
                      minLength={8}
                      className="h-11 transition-[border-color,box-shadow] duration-300"
                    />
                  </div>

                  <Button type="submit" className="h-11 w-full" disabled={loading}>
                    {loading ? 'Creating…' : 'Create account'}
                  </Button>
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
