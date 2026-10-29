import type { SVGProps } from "react";

/** Shared mark for the application, sign-in screen and printed documents. */
export function BrandMark({ size = 24, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden="true" {...props}>
      <path d="M16 3 27 7v8c0 6.2-4.4 10.6-11 14C9.4 25.6 5 21.2 5 15V7l11-4Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      <path d="M13 23V10h7v13M10 16h8m-3-3 3 3-3 3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
