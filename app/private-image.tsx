'use client';

import type { ComponentPropsWithRef } from 'react';

/** Private media and object URLs are requested by the browser, with its own session. */
export function PrivateImage(props: ComponentPropsWithRef<'img'> & { alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- Authenticated media must bypass the public image optimizer.
  return <img {...props} alt={props.alt} />;
}
