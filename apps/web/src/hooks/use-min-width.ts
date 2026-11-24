import { useEffect, useState } from 'react';

/** True when the viewport is at least `px` wide (follows resizes). Uses innerWidth like useIsMobile. */
export function useMinWidth(px: number): boolean {
  const [ok, setOk] = useState(() => (typeof window === 'undefined' ? true : window.innerWidth >= px));
  useEffect(() => {
    const on = () => setOk(window.innerWidth >= px);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, [px]);
  return ok;
}
