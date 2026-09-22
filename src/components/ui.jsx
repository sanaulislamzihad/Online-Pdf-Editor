/**
 * The small pieces the interface is built from.
 *
 * Buttons and icons are written once here so that every control in the app is
 * the same height, the same radius and the same weight - which is most of what
 * makes an interface look considered rather than assembled.
 */

const PATHS = {
  back: ['M15 19l-7-7 7-7'],
  open: ['M12 16V4', 'M7 9l5-5 5 5', 'M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3'],
  file: ['M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z', 'M14 3v5h5'],
  minus: ['M5 12h14'],
  plus: ['M12 5v14', 'M5 12h14'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10a6 6 0 0 1 0 12h-3'],
  download: ['M12 4v12', 'M7 11l5 5 5-5', 'M4 20h16'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
  trash: ['M4 7h16', 'M9 7V4h6v3', 'M6 7l1 13h10l1-13'],
  text: ['M6 5h12', 'M12 5v14', 'M9 19h6'],
  image: ['M4 5h16v14H4z', 'M4 15l4-4 3 3 4-4 5 5'],
  alert: ['M12 9v4', 'M12 17h.01', 'M10.3 3.9L2.5 17a2 2 0 0 0 1.7 3h15.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z'],
  lock: ['M5 11h14v9H5z', 'M9 11V7a3 3 0 0 1 6 0v4'],
  eye: ['M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6-10-6-10-6z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z'],
  wand: ['M5 19l9-9', 'M15 5l1.5 1.5', 'M18 9l1.5 1.5', 'M12 3l.8 2.2L15 6l-2.2.8L12 9l-.8-2.2L9 6l2.2-.8z'],
  check: ['M5 13l4 4 10-10'],
}

export function Icon({ name, className = 'h-4 w-4' }) {
  const paths = PATHS[name]
  if (!paths) return null
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      {paths.map((d) => <path key={d} d={d} />)}
    </svg>
  )
}

const VARIANTS = {
  primary: 'bg-blue-600 text-white shadow-sm hover:bg-blue-500 active:bg-blue-700 disabled:bg-slate-300 disabled:shadow-none',
  solid: 'bg-slate-900 text-white shadow-sm hover:bg-slate-800 active:bg-slate-950',
  outline: 'border border-slate-300 bg-white text-slate-700 shadow-sm hover:border-slate-400 hover:bg-slate-50 active:bg-slate-100',
  ghost: 'text-slate-600 hover:bg-slate-100 hover:text-slate-900',
  danger: 'bg-rose-600 text-white shadow-sm hover:bg-rose-500 active:bg-rose-700',
  violet: 'bg-violet-600 text-white shadow-sm hover:bg-violet-500 active:bg-violet-700',
}

const SIZES = {
  sm: 'h-7 px-2 text-[12px] gap-1',
  md: 'h-9 px-3 text-[13px] gap-1.5',
  lg: 'h-11 px-5 text-sm gap-2',
  icon: 'h-9 w-9',
  iconSm: 'h-7 w-7',
}

export function Button({
  variant = 'outline', size = 'md', icon, className = '', children, ...rest
}) {
  return (
    <button
      type="button"
      className={[
        'inline-flex select-none items-center justify-center rounded-lg font-medium',
        'transition-colors focus-visible:outline-none focus-visible:ring-2',
        'focus-visible:ring-blue-500/60 focus-visible:ring-offset-1',
        'disabled:cursor-not-allowed disabled:opacity-50',
        VARIANTS[variant],
        SIZES[size],
        className,
      ].join(' ')}
      {...rest}
    >
      {icon && <Icon name={icon} className={size === 'lg' ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />}
      {children}
    </button>
  )
}

/** A labelled block in one of the side panels. */
export function Field({ label, hint, muted, children }) {
  return (
    <div>
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <p className={`text-[11px] font-semibold uppercase tracking-[0.07em] ${muted ? 'text-slate-300' : 'text-slate-500'}`}>
          {label}
        </p>
        {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
      </div>
      {children}
    </div>
  )
}

/** A thin vertical rule between groups of toolbar controls. */
export const Divider = () => <span className="mx-1 h-6 w-px bg-slate-200" />
