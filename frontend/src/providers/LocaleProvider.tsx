"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";

export const supportedLocales = ["en", "it"] as const;
export type Locale = (typeof supportedLocales)[number];

const localeStorageKey = "prg32-locale";
const localeChangeEvent = "prg32-locale-change";

const messages = {
  en: {
    account: "Account",
    yourAccount: "Your account",
    workspace: "Workspace",
    developerDashboard: "Developer dashboard",
    publicProfile: "Public profile",
    signIn: "Sign in",
    signOut: "Sign out",
    signingOut: "Signing out…",
    language: "Language",
    english: "English",
    italian: "Italiano",
    loadingAccount: "Loading account",
    authUnavailable: "Auth unavailable",
    retryAuthentication: "Retry authentication",
    retry: "Retry",
    openAccountMenu: "Open account menu for",
    explore: "Explore",
    leaderboards: "Leaderboards",
    statistics: "Statistics",
    documentation: "Documentation",
    creatorStudio: "Creator Studio",
    reviewQueue: "Review queue",
    administration: "Administration",
    federation: "Federation",
  },
  it: {
    account: "Account",
    yourAccount: "Il tuo account",
    workspace: "Workspace",
    developerDashboard: "Dashboard sviluppatore",
    publicProfile: "Profilo pubblico",
    signIn: "Accedi",
    signOut: "Esci",
    signingOut: "Disconnessione…",
    language: "Lingua",
    english: "English",
    italian: "Italiano",
    loadingAccount: "Caricamento account",
    authUnavailable: "Autenticazione non disponibile",
    retryAuthentication: "Riprova autenticazione",
    retry: "Riprova",
    openAccountMenu: "Apri il menu account per",
    explore: "Esplora",
    leaderboards: "Classifiche",
    statistics: "Statistiche",
    documentation: "Documentazione",
    creatorStudio: "Creator Studio",
    reviewQueue: "Coda revisioni",
    administration: "Amministrazione",
    federation: "Federazione",
  },
} as const;

type MessageKey = keyof (typeof messages)["en"];

type LocaleContextValue = {
  locale: Locale;
  setLocale: (locale: Locale) => void;
  t: (key: MessageKey) => string;
};

const LocaleContext = createContext<LocaleContextValue>({
  locale: "en",
  setLocale: () => undefined,
  t: (key) => messages.en[key],
});

function readStoredLocale(): Locale {
  try {
    const stored = window.localStorage.getItem(localeStorageKey);
    return stored === "it" || stored === "en" ? stored : "en";
  } catch {
    return "en";
  }
}

export function LocaleProvider({ children }: Readonly<{ children: ReactNode }>) {
  const subscribe = useCallback((onStoreChange: () => void) => {
    window.addEventListener("storage", onStoreChange);
    window.addEventListener(localeChangeEvent, onStoreChange);
    return () => {
      window.removeEventListener("storage", onStoreChange);
      window.removeEventListener(localeChangeEvent, onStoreChange);
    };
  }, []);
  const locale = useSyncExternalStore(subscribe, readStoredLocale, () => "en" as Locale);
  const setLocale = useCallback((nextLocale: Locale) => {
    try {
      window.localStorage.setItem(localeStorageKey, nextLocale);
      window.dispatchEvent(new Event(localeChangeEvent));
    } catch {
      // Keep the current locale when browser storage is unavailable.
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key) => messages[locale][key],
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useLocale() {
  return useContext(LocaleContext);
}
