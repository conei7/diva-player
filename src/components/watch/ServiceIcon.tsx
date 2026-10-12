import type { PVService } from '../../types/vocadb';
import { LinkIcon } from '../ui/icons';

interface ServiceIconProps {
  service: PVService | string;
  size?: number;
  className?: string;
}

/** Single-color video service marks (they follow the text color). Unknown services get a link icon. */
export default function ServiceIcon({ service, size = 20, className }: ServiceIconProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'currentColor',
    'aria-hidden': true,
    focusable: false,
    className: className ? `shrink-0 ${className}` : 'shrink-0',
  } as const;

  switch (service) {
    case 'Youtube':
      return (
        <svg {...common}>
          <path d="M21.58 7.19a2.5 2.5 0 0 0-1.76-1.77C18.25 5 12 5 12 5s-6.25 0-7.82.42a2.5 2.5 0 0 0-1.76 1.77C2 8.75 2 12 2 12s0 3.25.42 4.81a2.5 2.5 0 0 0 1.76 1.77C5.75 19 12 19 12 19s6.25 0 7.82-.42a2.5 2.5 0 0 0 1.76-1.77C22 15.25 22 12 22 12s0-3.25-.42-4.81ZM10 15V9l5.2 3L10 15Z" />
        </svg>
      );
    case 'NicoNicoDouga':
      return (
        <svg {...common}>
          <path d="M8.3 2.3 12 6h.01l3.7-3.7 1.4 1.4L14.83 6H19a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3h-1.2l.9 1.8-1.8.9-1.35-2.7h-7.1L7.1 22.7l-1.8-.9.9-1.8H5a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3h4.17L6.9 3.7l1.4-1.4ZM5 8a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1H5Z" />
        </svg>
      );
    case 'SoundCloud':
      return (
        <svg {...common}>
          <path d="M11 7.5a5.5 5.5 0 0 1 5.38 4.36A3.5 3.5 0 1 1 17.5 18.8H11V7.5Zm-2 2.2V18.8H8V9.9c.32-.09.66-.16 1-.2ZM6 11.1v7.7H5v-7.3c.31-.17.65-.3 1-.4Zm-3 2.6v4.9a2.6 2.6 0 0 1-1-2.1 2.7 2.7 0 0 1 1-2.8Z" />
        </svg>
      );
    case 'Bilibili':
      return (
        <svg {...common}>
          <path d="M7.17 2.76 9.83 5.4h4.34l2.66-2.64 1.41 1.42L17 5.4h2a3 3 0 0 1 3 3v9a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3v-9a3 3 0 0 1 3-3h2L5.76 4.18l1.41-1.42ZM5 7.4a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H5Zm3 3.1h2v2.5H8v-2.5Zm6 0h2v2.5h-2v-2.5Z" />
        </svg>
      );
    default:
      return <LinkIcon size={size} className={className} />;
  }
}
