import { Toaster } from '@/components/ui/toaster';
import { Toaster as Sonner } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider } from '@/context/AuthContext';
import { ClubProvider } from '@/context/ClubContext';
import ProtectedRoute from '@/components/auth/ProtectedRoute';
import ClubGate from '@/components/auth/ClubGate';
import AppShell from '@/components/layout/AppShell';

import LandingPage from '@/pages/marketing/LandingPage';
import PublicLadderPage from '@/pages/marketing/PublicLadderPage';
import AuthPage from '@/pages/auth/AuthPage';
import OnboardingPage from '@/pages/onboarding/OnboardingPage';
import JoinClubPage from '@/pages/onboarding/JoinClubPage';
import HomePage from '@/pages/app/HomePage';
import SessionPage from '@/pages/app/SessionPage';
import MatchesPage from '@/pages/app/MatchesPage';
import MatchNewPage from '@/pages/app/MatchNewPage';
import MatchDetailPage from '@/pages/app/MatchDetailPage';
import RosterPage from '@/pages/app/RosterPage';
import PlayerProfilePage from '@/pages/app/PlayerProfilePage';
import LadderPage from '@/pages/app/LadderPage';
import SettingsPage from '@/pages/app/SettingsPage';
import ClaimPlayerPage from '@/pages/app/ClaimPlayerPage';
import AccountPage from '@/pages/app/AccountPage';
import NotFound from '@/pages/NotFound';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
});

const AppLayout = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>
    <ClubProvider>
      <ClubGate>
        <AppShell>{children}</AppShell>
      </ClubGate>
    </ClubProvider>
  </ProtectedRoute>
);

const AuthedClubProvider = ({ children }: { children: React.ReactNode }) => (
  <ProtectedRoute>
    <ClubProvider>{children}</ClubProvider>
  </ProtectedRoute>
);

const App = () => (
  <QueryClientProvider client={queryClient}>
    <AuthProvider>
      <TooltipProvider>
        <BrowserRouter basename={import.meta.env.BASE_URL.replace(/\/$/, '') || undefined}>
          <Routes>
            <Route path="/" element={<LandingPage />} />
            <Route path="/auth" element={<AuthPage />} />
            {/* Old email-verification links from the Supabase era. */}
            <Route path="/auth/callback" element={<Navigate to="/auth" replace />} />
            <Route path="/auth/verify-email" element={<Navigate to="/auth" replace />} />
            <Route path="/ladder/:token" element={<PublicLadderPage />} />

            <Route
              path="/onboarding"
              element={
                <AuthedClubProvider>
                  <OnboardingPage />
                </AuthedClubProvider>
              }
            />
            <Route
              path="/join/:code"
              element={
                <AuthedClubProvider>
                  <JoinClubPage />
                </AuthedClubProvider>
              }
            />

            <Route path="/app" element={<AppLayout><HomePage /></AppLayout>} />
            <Route path="/app/session" element={<AppLayout><SessionPage /></AppLayout>} />
            <Route path="/app/matches" element={<AppLayout><MatchesPage /></AppLayout>} />
            <Route path="/app/matches/new" element={<AppLayout><MatchNewPage /></AppLayout>} />
            <Route path="/app/matches/:id" element={<AppLayout><MatchDetailPage /></AppLayout>} />
            <Route path="/app/roster" element={<AppLayout><RosterPage /></AppLayout>} />
            <Route path="/app/roster/:id" element={<AppLayout><PlayerProfilePage /></AppLayout>} />
            <Route path="/app/ladder" element={<AppLayout><LadderPage /></AppLayout>} />
            <Route path="/app/settings" element={<AppLayout><SettingsPage /></AppLayout>} />
            <Route path="/app/account" element={<AppLayout><AccountPage /></AppLayout>} />
            <Route path="/app/claim" element={<AppLayout><ClaimPlayerPage /></AppLayout>} />

            {/* Legacy redirects */}
            <Route path="/players" element={<Navigate to="/app/roster" replace />} />
            <Route path="/team-balancer" element={<Navigate to="/app/session" replace />} />
            <Route path="/match-logger" element={<Navigate to="/app/matches" replace />} />
            <Route path="/statistics" element={<Navigate to="/app/ladder" replace />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </BrowserRouter>
        <Toaster />
        <Sonner />
      </TooltipProvider>
    </AuthProvider>
  </QueryClientProvider>
);

export default App;
