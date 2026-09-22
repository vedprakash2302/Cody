import type { SVGProps } from "react";

export function CodyMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M46 16a23 23 0 1 0 0 32"
        fill="none"
        stroke="currentColor"
        strokeWidth="11"
        strokeLinecap="round"
      />
      <rect x="45" y="26" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  );
}
