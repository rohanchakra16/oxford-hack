import type { SVGProps } from 'react';

/* Lucide (ISC) line icons, inlined so no icon dependency ships. One set, 24px grid, 1.75 stroke. */
type IconProps = SVGProps<SVGSVGElement>;
function Icon({ children, ...props }: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" {...props}>
      {children}
    </svg>
  );
}

export const PlayIcon = (props: IconProps) => (
  <Icon {...props}><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></Icon>
);

export const PauseIcon = (props: IconProps) => (
  <Icon {...props}><g><rect width="5" height="18" x="14" y="3" rx="1"/><rect width="5" height="18" x="5" y="3" rx="1"/></g></Icon>
);

export const VolumeIcon = (props: IconProps) => (
  <Icon {...props}><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM16 9a5 5 0 0 1 0 6m3.364 3.364a9 9 0 0 0 0-12.728"/></Icon>
);

export const VolumeOffIcon = (props: IconProps) => (
  <Icon {...props}><path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298zM22 9l-6 6m0-6l6 6"/></Icon>
);

export const FullscreenIcon = (props: IconProps) => (
  <Icon {...props}><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/></Icon>
);

export const ExpandIcon = (props: IconProps) => (
  <Icon {...props}><path d="M15 3h6v6m0-6l-7 7M3 21l7-7m-1 7H3v-6"/></Icon>
);

export const CollapseIcon = (props: IconProps) => (
  <Icon {...props}><path d="m14 10l7-7m-1 7h-6V4M3 21l7-7m-6 0h6v6"/></Icon>
);

export const DockIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/></g></Icon>
);

export const FlagIcon = (props: IconProps) => (
  <Icon {...props}><path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.333 2q2 0 3.067-.8A1 1 0 0 1 20 4v10a1 1 0 0 1-.4.8A6 6 0 0 1 16 16c-3 0-5-2-8-2a6 6 0 0 0-4 1.528"/></Icon>
);

export const ReplayIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M3 12a9 9 0 1 0 9-9a9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></g></Icon>
);

export const CloseIcon = (props: IconProps) => (
  <Icon {...props}><path d="M18 6L6 18M6 6l12 12"/></Icon>
);

export const UploadIcon = (props: IconProps) => (
  <Icon {...props}><path d="M12 3v12m5-7l-5-5l-5 5m14 7v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/></Icon>
);

export const FilmIcon = (props: IconProps) => (
  <Icon {...props}><g><rect width="18" height="18" x="3" y="3" rx="2"/><path d="M7 3v18M3 7.5h4M3 12h18M3 16.5h4M17 3v18m0-13.5h4m-4 9h4"/></g></Icon>
);

export const CameraIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M13.997 4a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 1.759-1.048l.489-.904A2 2 0 0 1 10.004 4z"/><circle cx="12" cy="13" r="3"/></g></Icon>
);

export const CameraOffIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M14.564 14.558a3 3 0 1 1-4.122-4.121M2 2l20 20"/><path d="M20 20H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2h1.997a2 2 0 0 0 .819-.175m2.879-2.801A2 2 0 0 1 10.004 4h3.993a2 2 0 0 1 1.76 1.05l.486.9A2 2 0 0 0 18.003 7H20a2 2 0 0 1 2 2v7.344"/></g></Icon>
);

export const ScanEyeIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M3 7V5a2 2 0 0 1 2-2h2m10 0h2a2 2 0 0 1 2 2v2m0 10v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><circle cx="12" cy="12" r="1"/><path d="M18.944 12.33a1 1 0 0 0 0-.66a7.5 7.5 0 0 0-13.888 0a1 1 0 0 0 0 .66a7.5 7.5 0 0 0 13.888 0"/></g></Icon>
);

export const EyeIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M2.062 12.348a1 1 0 0 1 0-.696a10.75 10.75 0 0 1 19.876 0a1 1 0 0 1 0 .696a10.75 10.75 0 0 1-19.876 0"/><circle cx="12" cy="12" r="3"/></g></Icon>
);

export const ActivityIcon = (props: IconProps) => (
  <Icon {...props}><path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/></Icon>
);

export const SettingsIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M14 17H5M19 7h-9"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/></g></Icon>
);

export const CaptionsIcon = (props: IconProps) => (
  <Icon {...props}><g><rect width="18" height="14" x="3" y="5" rx="2" ry="2"/><path d="M7 15h4m4 0h2M7 11h2m4 0h4"/></g></Icon>
);

export const ListIcon = (props: IconProps) => (
  <Icon {...props}><path d="M3 5h.01M3 12h.01M3 19h.01M8 5h13M8 12h13M8 19h13"/></Icon>
);

export const BookmarkIcon = (props: IconProps) => (
  <Icon {...props}><path d="M17 3a2 2 0 0 1 2 2v15a1 1 0 0 1-1.496.868l-4.512-2.578a2 2 0 0 0-1.984 0l-4.512 2.578A1 1 0 0 1 5 20V5a2 2 0 0 1 2-2z"/></Icon>
);

export const CheckIcon = (props: IconProps) => (
  <Icon {...props}><path d="M20 6L9 17l-5-5"/></Icon>
);

export const InfoIcon = (props: IconProps) => (
  <Icon {...props}><g><circle cx="12" cy="12" r="10"/><path d="M12 16v-4m0-4h.01"/></g></Icon>
);

export const ChevronDownIcon = (props: IconProps) => (
  <Icon {...props}><path d="m6 9l6 6l6-6"/></Icon>
);

export const ChevronRightIcon = (props: IconProps) => (
  <Icon {...props}><path d="m9 18l6-6l-6-6"/></Icon>
);

export const ThumbsUpIcon = (props: IconProps) => (
  <Icon {...props}><path d="M15 5.88L14 10h5.83a2 2 0 0 1 1.92 2.56l-2.33 8A2 2 0 0 1 17.5 22H4a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2h2.76a2 2 0 0 0 1.79-1.11L12 2a3.13 3.13 0 0 1 3 3.88M7 10v12"/></Icon>
);

export const ThumbsDownIcon = (props: IconProps) => (
  <Icon {...props}><path d="M9 18.12L10 14H4.17a2 2 0 0 1-1.92-2.56l2.33-8A2 2 0 0 1 6.5 2H20a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2.76a2 2 0 0 0-1.79 1.11L12 22a3.13 3.13 0 0 1-3-3.88M17 14V2"/></Icon>
);

export const UndoIcon = (props: IconProps) => (
  <Icon {...props}><g><path d="M9 14L4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 5.5 5.5a5.5 5.5 0 0 1-5.5 5.5H11"/></g></Icon>
);

export const AlertIcon = (props: IconProps) => (
  <Icon {...props}><g><circle cx="12" cy="12" r="10"/><path d="M12 8v4m0 4h.01"/></g></Icon>
);

export const CircleCheckIcon = (props: IconProps) => (
  <Icon {...props}><g><circle cx="12" cy="12" r="10"/><path d="m9 12l2 2l4-4"/></g></Icon>
);
