import { FilePickerButton } from './FilePickerButton';
import { FolderOpenIcon, SearchIcon, XIcon } from './Icons';

function Brand({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br from-rose-500 to-violet-600 text-sm font-black tracking-tight">R</span>
      <span className="min-w-0">
        <span className="block truncate text-[15px] leading-tight font-semibold">{title}</span>
        {subtitle && <span className="block truncate text-xs text-neutral-400">{subtitle}</span>}
      </span>
    </>
  );
}

export function Header({
  title,
  subtitle,
  query,
  onQuery,
  onFiles,
  onHome,
  showSearch,
  searchPlaceholder = 'Search scenes or characters',
}: {
  title: string;
  subtitle?: string;
  query: string;
  onQuery: (q: string) => void;
  onFiles: (files: File[]) => void;
  onHome?: () => void;
  showSearch: boolean;
  searchPlaceholder?: string;
}) {
  return (
    <header className="sticky top-0 z-30 border-b border-white/5 bg-neutral-950/85 pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center gap-3 pt-3 pr-[max(1rem,env(safe-area-inset-right))] pb-2 pl-[max(1rem,env(safe-area-inset-left))]">
        {onHome ? (
          <button type="button" onClick={onHome} className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-label="Home">
            <Brand title={title} subtitle={subtitle} />
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2.5">
            <Brand title={title} subtitle={subtitle} />
          </div>
        )}
        <FilePickerButton
          onFiles={onFiles}
          className="flex shrink-0 items-center gap-1.5 rounded-full bg-white px-3.5 py-2 text-sm font-semibold text-neutral-950 active:scale-95"
        >
          <FolderOpenIcon width={17} height={17} />
          Open
        </FilePickerButton>
      </div>
      {showSearch && (
        <div className="mx-auto max-w-6xl pr-[max(1rem,env(safe-area-inset-right))] pb-3 pl-[max(1rem,env(safe-area-inset-left))]">
          <label className="flex items-center gap-2 rounded-xl bg-white/[0.07] px-3 py-2.5 ring-1 ring-white/5 focus-within:ring-rose-400/50">
            <SearchIcon width={17} height={17} className="shrink-0 text-neutral-400" />
            <input
              type="search"
              inputMode="search"
              enterKeyHint="search"
              value={query}
              onChange={(e) => onQuery(e.target.value)}
              placeholder={searchPlaceholder}
              className="min-w-0 flex-1 bg-transparent text-[16px] outline-none placeholder:text-neutral-500"
            />
            {query && (
              <button type="button" onClick={() => onQuery('')} className="text-neutral-400" aria-label="Clear search">
                <XIcon width={17} height={17} />
              </button>
            )}
          </label>
        </div>
      )}
    </header>
  );
}
