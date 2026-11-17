'use client';
import { useEffect, useState } from 'react';

/** Time-dependent labels update even when the operational revision is unchanged. */
export function useClock(interval = 20000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}
