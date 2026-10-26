import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';
import './style.css';

const root = document.getElementById('root');
if (!root) throw new Error('Root element is missing');
createRoot(root).render(
  <BrowserRouter useTransitions={false}>
    <App />
  </BrowserRouter>,
);

// Development and Storybook must not install a worker on their origins.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker
      .register('/sw.js', { updateViaCache: 'none' })
      .catch(() => {
        // A failed registration must not prevent normal online use.
      });
  });
}
