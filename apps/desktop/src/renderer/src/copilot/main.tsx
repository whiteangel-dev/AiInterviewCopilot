import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '../styles.css';
import { CopilotApp } from './copilot-app';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root');

createRoot(root).render(
  <StrictMode>
    <CopilotApp />
  </StrictMode>,
);
