import { useEffect, useState, type RefObject } from 'react';

/**
 * One shared IntersectionObserver per rootMargin for the whole grid — far
 * cheaper on phones than an observer per card.
 */
type Listener = (visible: boolean) => void;
const observers = new Map<string, { io: IntersectionObserver; listeners: Map<Element, Listener> }>();

function getObserver(rootMargin: string) {
  let entry = observers.get(rootMargin);
  if (!entry) {
    const listeners = new Map<Element, Listener>();
    const io = new IntersectionObserver(
      (records) => {
        for (const r of records) listeners.get(r.target)?.(r.isIntersecting);
      },
      { rootMargin },
    );
    entry = { io, listeners };
    observers.set(rootMargin, entry);
  }
  return entry;
}

export function useInView(ref: RefObject<Element | null>, rootMargin = '400px 0px'): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const { io, listeners } = getObserver(rootMargin);
    listeners.set(el, setVisible);
    io.observe(el);
    return () => {
      io.unobserve(el);
      listeners.delete(el);
    };
  }, [ref, rootMargin]);
  return visible;
}
