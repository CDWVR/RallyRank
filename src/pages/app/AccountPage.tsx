import React, { useEffect, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/AuthContext';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { toast } from 'sonner';
import { describeError } from '@/lib/errors';

const AccountPage: React.FC = () => {
  const { user } = useAuth();
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [phone, setPhone] = useState('');
  const [username, setUsername] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('profiles')
      .select('username, first_name, last_name, phone')
      .eq('id', user.id)
      .maybeSingle()
      .then(({ data }) => {
        if (!data) return;
        setUsername(data.username || '');
        setFirstName(data.first_name || '');
        setLastName(data.last_name || '');
        setPhone(data.phone || '');
      });
  }, [user]);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    if (!firstName.trim() || !lastName.trim()) {
      toast.error('First and last name are required');
      return;
    }
    setSaving(true);
    const derived =
      username.trim() || `${firstName.trim()} ${lastName.trim()}`.trim();
    const { error } = await supabase.from('profiles').upsert({
      id: user.id,
      username: derived,
      first_name: firstName.trim(),
      last_name: lastName.trim(),
      phone: phone.trim() || null,
      updated_at: new Date().toISOString(),
    });
    setSaving(false);
    if (error) toast.error(describeError(error));
    else toast.success('Profile saved');
  };

  return (
    <div className="mx-auto max-w-md space-y-6">
      <div>
        <h1 className="font-display text-3xl font-bold text-ink">Account</h1>
        <p className="text-muted-foreground">{user?.email}</p>
      </div>

      <form onSubmit={save} className="surface-panel space-y-4 p-5">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="first-name">First name</Label>
            <Input
              id="first-name"
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              className="h-11"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="last-name">Last name</Label>
            <Input
              id="last-name"
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              className="h-11"
              required
            />
          </div>
        </div>
        <div className="space-y-2">
          <Label htmlFor="phone">Phone</Label>
          <Input
            id="phone"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="h-11"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="username">Display name</Label>
          <Input
            id="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="Defaults to first + last"
            className="h-11"
          />
        </div>
        <Button type="submit" className="w-full" disabled={saving}>
          {saving ? 'Saving…' : 'Save profile'}
        </Button>
      </form>
    </div>
  );
};

export default AccountPage;
