"use client";

import { useSyncExternalStore } from "react";

const noop = () => () => {};

/**
 * False on the server and during hydration, true after. Wallet state only exists in
 * the browser, so anything derived from it renders its server form until then.
 */
export const useHydrated = () => useSyncExternalStore(noop, () => true, () => false);
