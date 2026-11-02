import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useClub } from '@/context/ClubContext';
import { describeError } from '@/lib/errors';

const OnboardingPage: React.FC = () => {
  const { clubs, isLoading, createClub, joinClub } = useClub();
  const navigate = useNavigate();
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isLoading && clubs.length > 0) {
      navigate('/app', { replace: true });
    }
  }, [clubs, isLoading, navigate]);

  const onCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await createClub(name.trim());
      toast.success('Club created');
      navigate('/app');
    } catch (err: unknown) {
      toast.error(describeError(err, 'Could not create club'));
    } finally {
      setBusy(false);
    }
  };

  const onJoin = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await joinClub(code.trim());
      toast.success('Joined club');
      navigate('/app');
    } catch (err: unknown) {
      toast.error(describeError(err, 'Invalid invite code'));
    } finally {
      setBusy(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center court-lines">
        <p className="text-muted-foreground">Loading…</p>
      </div>
    );
  }

  return (
    <div className="court-lines flex min-h-screen items-center justify-center px-4 py-10">
      <div className="w-full max-w-lg surface-panel p-6 md:p-8">
        <h1 className="font-display text-3xl font-bold text-ink">Set up your club</h1>
        <p className="mt-2 text-muted-foreground">
          Create a new club or join one with an invite code.
        </p>

        <div className="mt-6 flex gap-2">
          <Button
            type="button"
            variant={mode === 'create' ? 'default' : 'outline'}
            onClick={() => setMode('create')}
          >
            Create club
          </Button>
          <Button
            type="button"
            variant={mode === 'join' ? 'default' : 'outline'}
            onClick={() => setMode('join')}
          >
            Join with code
          </Button>
        </div>

        {mode === 'create' ? (
          <form onSubmit={onCreate} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="club-name">Club name</Label>
              <Input
                id="club-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Saturday Smashers"
                required
                className="h-11"
              />
            </div>
            <Button type="submit" className="h-11 w-full" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create club'}
            </Button>
          </form>
        ) : (
          <form onSubmit={onJoin} className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="invite-code">Invite code</Label>
              <Input
                id="invite-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCD1234"
                required
                className="h-11 uppercase tracking-widest"
              />
            </div>
            <Button type="submit" className="h-11 w-full" disabled={busy || !code.trim()}>
              {busy ? 'Joining…' : 'Join club'}
            </Button>
          </form>
        )}
      </div>
    </div>
  );
};

export default OnboardingPage;
