import { useId } from 'react';

/** App mark: a speech bubble holding a voice waveform. Also used for the app icon. */
export function Logo({ className }: { className?: string }) {
  const id = useId();
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#6366f1" />
          <stop offset="1" stopColor="#8b5cf6" />
        </linearGradient>
      </defs>
      <rect width="32" height="32" rx="8" fill={`url(#${id})`} />
      <path
        d="M7.5 12a4 4 0 0 1 4-4h9a4 4 0 0 1 4 4v5a4 4 0 0 1-4 4h-5.3l-3.8 3.05c-.55.44-1.4.05-1.4-.66V20.8A4 4 0 0 1 7.5 17z"
        fill="#fff"
      />
      <g fill="#5b50ea">
        <rect x="11.6" y="12.6" width="1.9" height="3.8" rx=".95" />
        <rect x="15.05" y="10.6" width="1.9" height="7.8" rx=".95" />
        <rect x="18.5" y="12.6" width="1.9" height="3.8" rx=".95" />
      </g>
    </svg>
  );
}
