import type { SVGProps } from "react";

// Terminal pup: pointed spitz ears on a prompt window showing ">_".
export function CodyMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M8 19L18 5L28 19H36L46 5L56 19V47L32 60L8 47Z M16 27L19.5 24L30 33L19.5 42L16 39L22.5 33Z M33 38H47V43H33Z"
      />
    </svg>
  );
}
