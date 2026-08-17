"use client";

import { useCallback, useEffect } from "react";

import { useStored, writeStored } from "./storage";

export type ThemePref = "light" | "dark" | "system";
const KEY = "theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

/** Runs in <head> before first paint so the stored theme never flashes. */
export const themeScript = `(function(){try{var p=localStorage.getItem("${KEY}")||"system";var d=p==="dark"||(p!=="light"&&matchMedia("${DARK_QUERY}").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})()`;

function apply(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && matchMedia(DARK_QUERY).matches);
  document.documentElement.setAttribute("data-theme", dark ? "dark" : "light");
}

export function useThemePref(): [ThemePref, (p: ThemePref) => void] {
  const stored = useStored(KEY);
  const pref: ThemePref = stored === "light" || stored === "dark" ? stored : "system";

  // Follow the OS while on "system".
  useEffect(() => {
    if (pref !== "system") return;
    const mq = matchMedia(DARK_QUERY);
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  const setPref = useCallback((p: ThemePref) => {
    writeStored(KEY, p === "system" ? null : p);
    apply(p);
  }, []);

  return [pref, setPref];
}
