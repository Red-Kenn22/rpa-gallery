/**
 * Service-worker registration in "prompt" mode: a new deploy waits instead of
 * reloading the page (which would drop the user's loaded File handles). When
 * an update is waiting, `onUpdateReady` listeners get a function that applies it.
 */

type Listener = (apply: () => void) => void;
const listeners = new Set<Listener>();
let pending: (() => void) | null = null;

export function onUpdateReady(fn: Listener): () => void {
  listeners.add(fn);
  if (pending) fn(pending);
  return () => listeners.delete(fn);
}

function announce(worker: ServiceWorker): void {
  pending = () => {
    navigator.serviceWorker.addEventListener('controllerchange', () => location.reload(), { once: true });
    worker.postMessage({ type: 'SKIP_WAITING' }); // handled by the Workbox-generated sw.js
  };
  for (const fn of listeners) fn(pending);
}

export function registerServiceWorker(): void {
  // sw.js only exists in production builds (vite-plugin-pwa); skip in dev and tests.
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('./sw.js', { scope: './' })
      .then((reg) => {
        if (reg.waiting && navigator.serviceWorker.controller) announce(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const installing = reg.installing;
          installing?.addEventListener('statechange', () => {
            // Only an *update* (a controller already exists) needs a prompt.
            if (installing.state === 'installed' && navigator.serviceWorker.controller) announce(installing);
          });
        });
        // Check for new deploys now and then while the app stays open.
        setInterval(() => void reg.update().catch(() => {}), 60 * 60 * 1000);
      })
      .catch(() => {
        /* no sw.js in dev / tests */
      });
  });
}
