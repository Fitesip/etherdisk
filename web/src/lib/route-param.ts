import { useParams, usePathname } from "next/navigation";

/** The one id the static export (the desktop app) prerenders for each dynamic route. */
export const EXPORTED_PARAM = "_";

/**
 * A dynamic route parameter. The desktop app serves the page prerendered for `_` at every
 * id (`/drive/7` gets `/drive/_`), so there the real value comes from the address:
 * `segment` is its position in the path (`/drive/7` → 1).
 */
export function useRouteParam(name: string, segment: number): string {
  const value = useParams<Record<string, string>>()[name];
  const pathname = usePathname();
  if (value !== EXPORTED_PARAM) return value;
  const fromPath = (path: string) => path.split("/")[segment + 1];
  // usePathname follows client navigation; the address bar covers the first render.
  const id = [pathname, typeof window === "undefined" ? "" : window.location.pathname].map(fromPath).find((s) => s && s !== EXPORTED_PARAM);
  return id ? decodeURIComponent(id) : value;
}
