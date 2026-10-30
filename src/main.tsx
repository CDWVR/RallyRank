import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import ErrorBoundary from '@/components/ErrorBoundary';
import './index.css';


createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    const swUrl = `${import.meta.env.BASE_URL}sw.js`;
    navigator.serviceWorker.register(swUrl).catch(() => {
      /* PWA optional */
    });
  });
}
