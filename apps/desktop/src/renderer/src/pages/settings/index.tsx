import { useEffect } from 'react';
import { Page } from '../../components/page';
import { useApp } from '../../store';
import { AboutCard } from './about-card';
import { AnswersCard, AppearanceCard } from './preferences-cards';
import { ApiKeyCard } from './api-key-card';
import { ModelsCard } from './models-card';
import { PrivacyCard } from './privacy-card';

export function SettingsPage() {
  const focusSection = useApp((s) => s.focusSection);
  const clearFocusSection = useApp((s) => s.clearFocusSection);

  useEffect(() => {
    if (!focusSection) return;
    const el = document.getElementById(focusSection);
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    el?.querySelector<HTMLElement>('input, button')?.focus({ preventScroll: true });
    clearFocusSection();
  }, [focusSection, clearFocusSection]);

  return (
    <Page title="Settings" description="Changes are saved automatically.">
      <ApiKeyCard />
      <ModelsCard />
      <AnswersCard />
      <AppearanceCard />
      <PrivacyCard />
      <AboutCard />
    </Page>
  );
}
