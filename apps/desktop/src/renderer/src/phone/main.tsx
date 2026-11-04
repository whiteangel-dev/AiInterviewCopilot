import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { PhoneApp } from './phone-app';

// The pairing token is now a cookie; keep it out of the address bar and history.
if (location.search.includes('k=')) history.replaceState(null, '', '/');

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <PhoneApp />
  </StrictMode>,
);
