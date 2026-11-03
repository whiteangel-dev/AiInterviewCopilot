import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { FatalScreen } from './components/fatal-screen';
import { Sidebar } from './components/sidebar';
import { Toaster } from './components/toaster';
import { AnswersPage } from './pages/answers';
import { HomePage } from './pages/home';
import { KnowledgePage } from './pages/knowledge';
import { ProfilesPage } from './pages/profiles';
import { SettingsPage } from './pages/settings';
import { useApp } from './store';

export function App() {
  const boot = useApp((s) => s.boot);
  const page = useApp((s) => s.page);
  const ready = useApp((s) => s.settings !== null && s.apiKey !== null);
  const fatal = useApp((s) => s.fatal);
  const profileId = useApp((s) => s.profileId);

  useEffect(() => {
    boot().catch((err: unknown) => console.error('boot failed', err));
  }, [boot]);

  return (
    <div className="flex h-full" data-app-ready={ready && !fatal ? 'true' : 'false'}>
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* Title bar strip; window controls are drawn over its right end. */}
        <div className="drag h-10 shrink-0" />
        {/* Keyed by page so each page starts scrolled to the top. */}
        <main
          key={page + (page === 'profiles' ? (profileId ?? '') : '')}
          className="min-h-0 flex-1 overflow-y-auto"
          id="main"
        >
          {fatal ? (
            <FatalScreen error={fatal} />
          ) : !ready ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 size-4 animate-spin" aria-hidden /> Starting…
            </div>
          ) : (
            {
              home: <HomePage />,
              profiles: <ProfilesPage />,
              knowledge: <KnowledgePage />,
              answers: <AnswersPage />,
              settings: <SettingsPage />,
            }[page]
          )}
        </main>
      </div>
      <Toaster />
    </div>
  );
}
