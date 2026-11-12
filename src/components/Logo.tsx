// SafeBalance logo: a padlock with a tick on a green tile ("locked and checked").
// Same drawing as src/app/icon.svg and public/brand/*.

export const BRAND_GREEN = "#0f7a4a";

export function LogoMark({ size = 28, title }: { size?: number; title?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-hidden={title ? undefined : true}>
      {title && <title>{title}</title>}
      <rect width="64" height="64" rx="14" fill={BRAND_GREEN} />
      <path d="M22 28V21a10 10 0 0 1 20 0v7" fill="none" stroke="#fff" strokeWidth="5" strokeLinecap="round" />
      <rect x="14" y="27" width="36" height="26" rx="6" fill="#fff" />
      <path d="M23 40l6 6 12-12" fill="none" stroke={BRAND_GREEN} strokeWidth="4.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Mark plus the name, for headers. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span className="inline-flex items-center gap-2 text-lg text-stone-900">
      <LogoMark size={size} />
      <span>
        <span className="font-bold">Safe</span>
        <span className="font-medium">Balance</span>
      </span>
    </span>
  );
}
