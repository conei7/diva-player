import { useEffect, useId, useMemo, useRef, useState } from 'react';
import type { FocusEvent, FormEvent, KeyboardEvent, ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { getSearchSuggestions, type SearchSuggestion } from '../../api/vocadb';
import { useTranslate, useTranslateSourceText } from '../../i18n';
import { FINE_HOVER_MEDIA_QUERY, useMediaQuery } from '../../hooks/useMediaQuery';
import { useLanguageStore, type AppLanguage } from '../../stores/languageStore';
import { useUiStore } from '../../stores/uiStore';
import { artistPath, searchPath, watchPath, type SearchType } from '../../utils/routes';
import { artistTypeLabel, formatArtistLine } from '../../utils/songMeta';
import Button from '../ui/Button';
import IconButton from '../ui/IconButton';
import Tooltip from '../ui/Tooltip';
import { ClockIcon, CloseIcon, MicIcon, MusicNoteIcon, PersonIcon, SearchIcon, TuneIcon } from '../ui/iconsChrome';
import { cx } from '../ui/overlay';

const SEARCH_HISTORY_KEY = 'divaSearchHistory';
const MAX_SEARCH_HISTORY = 10;
/** History entries shown above the suggestions while typing. */
const MATCHING_HISTORY_LIMIT = 3;
const SUGGESTION_DELAY_MS = 220;
/** The listbox id (aria-controls of the input; e2e tests find the panel through it). */
const LISTBOX_ID = 'search-suggestions';

function readSearchHistory(): string[] {
  try {
    const raw = window.localStorage.getItem(SEARCH_HISTORY_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is string => typeof item === 'string').slice(0, MAX_SEARCH_HISTORY);
  } catch {
    return [];
  }
}

function writeSearchHistory(history: string[]) {
  try {
    window.localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Ignore storage failures; search itself should keep working.
  }
}

type SearchOption =
  | { type: 'history'; term: string }
  | { type: 'suggestion'; suggestion: SearchSuggestion };

function optionKey(option: SearchOption): string {
  return option.type === 'history'
    ? `history:${option.term}`
    : `${option.suggestion.kind}:${option.suggestion.id}`;
}

/** Voice library names are product names (the same in both languages). */
function vocalistTypeLabel(type: string, language: AppLanguage): string {
  switch (type) {
    case 'Vocaloid': return 'VOCALOID';
    case 'UTAU': return 'UTAU';
    case 'CeVIO': return 'CeVIO';
    case 'SynthesizerV': return 'Synthesizer V';
    case 'NEUTRINO': return 'NEUTRINO';
    case 'VoiSona': return 'VoiSona';
    case 'Voiceroid': return 'VOICEROID';
    case 'NewType': return language === 'ja' ? 'ピアプロ NT' : 'Piapro NT';
    case 'ACEVirtualSinger': return 'ACE Studio';
    case 'VOICEVOX': return 'VOICEVOX';
    case 'AIVOICE': return 'A.I.VOICE';
    default: return artistTypeLabel(type, language);
  }
}

/** YouTube style: the part that matches what was typed stays regular, the rest is bold. */
function highlightCompletion(label: string, typed: string): ReactNode {
  const query = typed.trim();
  if (!query) return label;
  const index = label.toLocaleLowerCase().indexOf(query.toLocaleLowerCase());
  if (index < 0) return label;
  const before = label.slice(0, index);
  const match = label.slice(index, index + query.length);
  const after = label.slice(index + query.length);
  return (
    <>
      {before && <b className="font-bold">{before}</b>}
      {match}
      {after && <b className="font-bold">{after}</b>}
    </>
  );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]') !== null;
}

/**
 * The search box of the top bar (DESIGN_SPEC §6.1.2): a combobox with the recent searches and
 * VocaDB suggestions. Running a search only changes the URL (`/?q=…`); Home reads the URL and
 * searches. Desktop: [input][🔍 64px] [Advanced search]. Mobile (`compact`): one rounded field
 * with Advanced search inside, suggestions full width under the bar.
 */
export default function SearchBox({ compact }: { compact: boolean }) {
  const t = useTranslateSourceText();
  const tk = useTranslate();
  const language = useLanguageStore(state => state.language);
  const navigate = useNavigate();
  const location = useLocation();
  const advancedSearchOpen = useUiStore(state => state.advancedSearchOpen);
  const toggleAdvancedSearch = useUiStore(state => state.toggleAdvancedSearch);
  const setAdvancedSearchOpen = useUiStore(state => state.setAdvancedSearchOpen);
  const startNavigation = useUiStore(state => state.startNavigation);
  // Phones and touch screens: 48px rows and a 40px × for each recent search, so a press next to
  // it does not run the search instead. Mouse: 36px rows and 「削除」 on hover (DESIGN_SPEC §1.9).
  const fineHover = useMediaQuery(FINE_HOVER_MEDIA_QUERY);
  const touchRows = compact || !fineHover;

  const params = location.pathname === '/' ? new URLSearchParams(location.search) : null;
  const urlQuery = params?.get('q') ?? null;
  const urlHasArtist = Boolean(params?.get('artistId'));

  const [query, setQuery] = useState(() => urlQuery ?? '');
  const [focused, setFocused] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [suggestions, setSuggestions] = useState<SearchSuggestion[]>([]);
  const [history, setHistory] = useState<string[]>(() => readSearchHistory());
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const optionIdPrefix = useId();
  const trimmed = query.trim();

  // The URL is the source of truth: show the searched words on a results page, empty the box
  // when Home is opened without a search (logo, guide, back button).
  useEffect(() => {
    if (location.pathname !== '/') return;
    if (urlQuery !== null) setQuery(urlQuery);
    else if (!urlHasArtist) setQuery('');
  }, [location.key, location.pathname, urlHasArtist, urlQuery]);

  useEffect(() => {
    if (trimmed.length < 2) {
      setSuggestions([]);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      getSearchSuggestions(trimmed)
        .then(results => {
          if (!cancelled) setSuggestions(results);
        })
        .catch(() => {
          if (!cancelled) setSuggestions([]);
        });
    }, SUGGESTION_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [trimmed]);

  // 「/」 focuses the search box (not while typing elsewhere or while a modal is open).
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== '/' || event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if (isEditableTarget(event.target) || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      inputRef.current?.focus();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const options = useMemo<SearchOption[]>(() => {
    const lowered = trimmed.toLocaleLowerCase();
    const historyOptions = (trimmed
      ? history.filter(term => term.toLocaleLowerCase().startsWith(lowered)).slice(0, MATCHING_HISTORY_LIMIT)
      : history
    ).map(term => ({ type: 'history' as const, term }));
    const suggestionOptions = trimmed.length >= 2
      ? suggestions.map(suggestion => ({ type: 'suggestion' as const, suggestion }))
      : [];
    return [...historyOptions, ...suggestionOptions];
  }, [history, suggestions, trimmed]);

  const panelVisible = open && options.length > 0;
  const showClearHistory = panelVisible && !trimmed && history.length > 0;
  const activeOption = panelVisible && activeIndex >= 0 ? options[activeIndex] : undefined;
  const optionId = (index: number) => `${optionIdPrefix}option-${index}`;

  const closePanel = () => {
    setOpen(false);
    setActiveIndex(-1);
  };

  const rememberSearch = (term: string) => {
    const normalized = term.trim();
    if (!normalized) return;
    setHistory(current => {
      const next = [
        normalized,
        ...current.filter(item => item.toLocaleLowerCase() !== normalized.toLocaleLowerCase()),
      ].slice(0, MAX_SEARCH_HISTORY);
      writeSearchHistory(next);
      return next;
    });
  };

  const removeHistoryTerm = (term: string) => {
    setActiveIndex(-1);
    setHistory(current => {
      const next = current.filter(item => item !== term);
      writeSearchHistory(next);
      return next;
    });
  };

  const clearHistory = () => {
    setHistory([]);
    writeSearchHistory([]);
    closePanel();
    inputRef.current?.focus();
  };

  // Like the guide, a press that leaves the current page starts the top loading bar.
  const goTo = (target: string) => {
    const current = `${location.pathname}${location.search}`;
    if (current !== target) startNavigation(target);
    navigate(target, { replace: current === target });
  };

  const goToSearch = (term: string, type?: SearchType) => goTo(searchPath(term, type));

  const finishInput = () => {
    closePanel();
    inputRef.current?.blur();
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmed) return;
    rememberSearch(trimmed);
    finishInput();
    goToSearch(trimmed);
  };

  const selectOption = (option: SearchOption) => {
    finishInput();
    if (option.type === 'history') {
      setQuery(option.term);
      rememberSearch(option.term);
      goToSearch(option.term);
      return;
    }
    const { suggestion } = option;
    rememberSearch(suggestion.label);
    if (suggestion.kind === 'song') {
      setQuery(suggestion.label);
      goTo(watchPath(suggestion.id));
      return;
    }
    if (suggestion.kind === 'producer') {
      setQuery(suggestion.label);
      goTo(artistPath({ id: suggestion.id, name: suggestion.label }));
      return;
    }
    // Vocalists search with the typed words so every voicebank of the singer matches.
    const term = trimmed || suggestion.label;
    setQuery(term);
    goToSearch(term, 'vocalist');
  };

  const moveActive = (step: 1 | -1) => {
    const count = options.length;
    if (count === 0) return;
    setActiveIndex(current => {
      const next = current + step;
      if (next >= count) return -1;
      if (next < -1) return count - 1;
      return next;
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveActive(1);
    } else if (event.key === 'ArrowUp') {
      if (!panelVisible) return;
      event.preventDefault();
      moveActive(-1);
    } else if (event.key === 'Enter' && activeOption) {
      event.preventDefault();
      selectOption(activeOption);
    } else if (event.key === 'Escape' && panelVisible) {
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    } else if (event.key === 'Delete' && event.shiftKey && activeOption?.type === 'history') {
      event.preventDefault();
      removeHistoryTerm(activeOption.term);
    }
  };

  // The panel stays open while focus moves inside the form (e.g. Tab to 「検索履歴をすべて削除」).
  const onFormBlur = (event: FocusEvent<HTMLFormElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && formRef.current?.contains(next)) return;
    closePanel();
  };

  const clearInput = () => {
    setQuery('');
    setActiveIndex(-1);
    setOpen(true);
    inputRef.current?.focus();
  };

  const onAdvancedSearch = () => {
    if (location.pathname !== '/') {
      setAdvancedSearchOpen(true);
      goTo('/');
      return;
    }
    toggleAdvancedSearch();
  };

  const kindLabel = (kind: SearchSuggestion['kind']) => {
    if (kind === 'song') return tk('suggestionSong');
    if (kind === 'producer') return tk('suggestionProducer');
    return tk('suggestionVocalist');
  };

  const renderOption = (option: SearchOption, index: number) => {
    const active = index === activeIndex;
    let icon: ReactNode;
    let label: string;
    let detail = '';
    // Read out what kind of suggestion it is when the visible detail does not already say so.
    let kind = '';
    if (option.type === 'history') {
      icon = <ClockIcon />;
      label = option.term;
    } else {
      const { suggestion } = option;
      label = suggestion.label;
      kind = kindLabel(suggestion.kind);
      if (suggestion.kind === 'song') {
        icon = <MusicNoteIcon />;
        detail = formatArtistLine(suggestion.song) || suggestion.sublabel;
      } else if (suggestion.kind === 'producer') {
        icon = <PersonIcon />;
        detail = artistTypeLabel(suggestion.artist.artistType, language);
      } else {
        icon = <MicIcon />;
        detail = vocalistTypeLabel(suggestion.artist.artistType, language);
      }
    }
    return (
      <li key={optionKey(option)} role="presentation" className="group relative flex items-center">
        <div
          id={optionId(index)}
          role="option"
          aria-selected={active}
          onClick={() => selectOption(option)}
          onPointerMove={() => {
            if (!active) setActiveIndex(index);
          }}
          className={cx(
            'flex min-w-0 flex-1 cursor-pointer select-none items-center gap-4 px-4 text-left',
            touchRows ? 'h-12' : 'h-9',
            option.type === 'history' && (touchRows ? 'pr-14' : 'pr-20'),
            active && 'bg-yt-tonal',
          )}
        >
          <span aria-hidden="true" className="flex shrink-0 text-yt-text">{icon}</span>
          <span className="min-w-0 flex-1 truncate text-base leading-6 text-yt-text">
            {highlightCompletion(label, query)}
            {detail && <span className="text-[13px] leading-[18px] text-yt-text-secondary"> · {detail}</span>}
            {kind && kind !== detail && <span className="sr-only">{`, ${kind}`}</span>}
          </span>
        </div>
        {/* Out of the Tab order: the keyboard removes the highlighted entry with Shift+Delete. */}
        {option.type === 'history' && (touchRows ? (
          // IconButton is position: relative itself, so the wrapper places it over the row's right end.
          <span className="absolute inset-y-0 right-2 flex items-center">
            <IconButton
              label={t('「{term}」を履歴から削除', { term: option.term })}
              icon={<CloseIcon />}
              tabIndex={-1}
              onClick={() => removeHistoryTerm(option.term)}
            />
          </span>
        ) : (
          <button
            type="button"
            tabIndex={-1}
            aria-label={t('「{term}」を履歴から削除', { term: option.term })}
            onClick={() => removeHistoryTerm(option.term)}
            className="reveal-on-hover absolute right-3 top-1/2 -translate-y-1/2 cursor-pointer rounded-full px-2 py-1 text-xs font-medium leading-4 text-yt-link hover:bg-yt-link/10"
          >
            {tk('searchHistoryRemove')}
          </button>
        ))}
      </li>
    );
  };

  const panel = panelVisible ? (
    <div
      data-testid="search-suggestions-panel"
      // Keep the focus in the input while the pointer is pressed on the panel.
      onMouseDown={event => event.preventDefault()}
      className={cx(
        'overflow-y-auto overscroll-contain bg-yt-raised py-2 shadow-[0_4px_32px_rgba(0,0,0,0.5)]',
        compact
          ? 'fixed inset-x-0 top-[var(--header-height)] max-h-[calc(100dvh-var(--header-height)-var(--bottom-nav-height,0px))]'
          : 'absolute inset-x-0 top-[calc(100%+4px)] max-h-[calc(100dvh-var(--header-height)-16px)] rounded-card',
      )}
    >
      <ul role="listbox" id={LISTBOX_ID} aria-label={t('検索候補')}>
        {options.map(renderOption)}
      </ul>
      {showClearHistory && (
        <div className="flex justify-end px-3 pt-1">
          <Button variant="text" size="sm" onClick={clearHistory}>{tk('clear')}</Button>
        </div>
      )}
    </div>
  ) : null;

  const input = (
    <input
      ref={inputRef}
      type="search"
      name="search_query"
      role="combobox"
      aria-label={tk('search')}
      aria-autocomplete="list"
      aria-expanded={panelVisible}
      aria-controls={panelVisible ? LISTBOX_ID : undefined}
      aria-activedescendant={activeOption ? optionId(activeIndex) : undefined}
      placeholder={tk('searchPlaceholder')}
      value={query}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="none"
      spellCheck={false}
      enterKeyHint="search"
      onChange={event => {
        setQuery(event.target.value);
        setActiveIndex(-1);
        setOpen(true);
      }}
      onFocus={() => {
        setFocused(true);
        setOpen(true);
      }}
      onBlur={() => setFocused(false)}
      onKeyDown={onInputKeyDown}
      // text-ellipsis: a placeholder (or words) wider than the field ends with … instead of being cut.
      className="h-full min-w-0 flex-1 text-ellipsis bg-transparent text-base leading-6 text-yt-text outline-none placeholder:text-yt-text-secondary [&::-webkit-search-cancel-button]:appearance-none [&::-webkit-search-decoration]:appearance-none"
    />
  );

  const clearButton = query ? (
    <IconButton
      size="sm"
      label={t('検索をクリア')}
      icon={<CloseIcon />}
      onMouseDown={event => event.preventDefault()}
      onClick={clearInput}
    />
  ) : null;

  const advancedSearchButton = (
    <IconButton
      label={tk('advancedSearch')}
      icon={<TuneIcon />}
      variant={compact ? 'ghost' : 'tonal'}
      pressed={advancedSearchOpen}
      onClick={onAdvancedSearch}
    />
  );

  if (compact) {
    return (
      <form ref={formRef} role="search" onSubmit={submit} onBlur={onFormBlur} className="flex min-w-0 flex-1">
        <div
          className={cx(
            'flex h-10 min-w-0 flex-1 items-center rounded-full bg-yt-tonal-solid pl-3 ring-1 ring-inset',
            focused ? 'ring-yt-field-focus' : 'ring-transparent',
          )}
        >
          <SearchIcon size={20} className="mr-2 text-yt-text-secondary" />
          {input}
          {clearButton}
          {advancedSearchButton}
        </div>
        {panel}
      </form>
    );
  }

  return (
    <div className="flex w-full min-w-0 max-w-[728px] items-center gap-3">
      <form ref={formRef} role="search" onSubmit={submit} onBlur={onFormBlur} className="relative flex min-w-0 flex-1">
        <div
          className={cx(
            'flex h-10 min-w-0 flex-1 items-center rounded-l-full border border-r-0 bg-yt-field pl-4 pr-1',
            focused ? 'border-yt-field-focus' : 'border-yt-field-border',
          )}
        >
          {focused && <SearchIcon size={20} className="mr-3 text-yt-text" />}
          {input}
          {clearButton}
        </div>
        <Tooltip content={tk('search')}>
          <button
            type="submit"
            aria-label={tk('search')}
            className="flex h-10 w-16 shrink-0 cursor-pointer items-center justify-center rounded-r-full border border-yt-field-border bg-[#222] text-yt-text transition-colors duration-150 hover:bg-yt-tonal-solid-hover"
          >
            <SearchIcon />
          </button>
        </Tooltip>
        {panel}
      </form>
      {advancedSearchButton}
    </div>
  );
}
