import { Svg } from '../../ui/iconBase';
import type { IconProps } from '../../ui/iconBase';

/** 「再生中」 panel toggle: a window with its right column filled (where the panel opens). */
export default function NowPlayingViewIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6zm2 0v12h9V6H5z" />
    </Svg>
  );
}
