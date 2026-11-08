import { Svg } from '../ui/iconBase';
import type { IconProps } from '../ui/iconBase';

/** 小窓プレイヤー: a window with a small filled window in its lower right corner. */
export default function FloatingPlayerIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3h14a2 2 0 0 1 2 2v6h-2V5H5v14h6v2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z" />
      <rect x="13" y="13" width="9" height="8" rx="1.5" />
    </Svg>
  );
}
