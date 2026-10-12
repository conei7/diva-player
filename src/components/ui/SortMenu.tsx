import { useTranslateSourceText } from '../../i18n';
import Button from './Button';
import IconButton from './IconButton';
import Menu, { MenuItemRadio } from './Menu';
import { SortIcon } from './icons';

export interface SortMenuOption<T extends string> {
  value: T;
  label: string;
}

export interface SortMenuProps<T extends string> {
  value: T;
  options: SortMenuOption<T>[];
  onChange: (value: T) => void;
  /** Default 「並べ替え」. Trigger text (or tooltip / aria-label when compact) and menu label. */
  label?: string;
  /** Icon button only. */
  compact?: boolean;
  disabled?: boolean;
}

/** Tonal 「並べ替え」 button (or an icon button) that opens a radio menu of the options. */
export default function SortMenu<T extends string>({
  value,
  options,
  onChange,
  label,
  compact = false,
  disabled = false,
}: SortMenuProps<T>) {
  const t = useTranslateSourceText();
  const text = label ?? t('並べ替え');

  const trigger = compact ? (
    <IconButton label={text} icon={<SortIcon />} disabled={disabled} />
  ) : (
    <Button variant="tonal" size="md" icon={<SortIcon size={20} />} disabled={disabled}>
      {text}
    </Button>
  );

  return (
    <Menu trigger={trigger} align="start" label={text}>
      {options.map(option => (
        <MenuItemRadio
          key={option.value}
          checked={option.value === value}
          onSelect={() => {
            if (option.value !== value) onChange(option.value);
          }}
        >
          {option.label}
        </MenuItemRadio>
      ))}
    </Menu>
  );
}
