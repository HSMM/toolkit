// i18n-инфраструктура. В MVP только русский (ТЗ 5.4), но ключи разнесены —
// добавление другого языка не потребует переписывания страниц.

import type { ReactNode } from "react";
import i18next from "i18next";
import { initReactI18next, useTranslation as useTranslationOrig } from "react-i18next";
import ru from "./ru.json";

void i18next.use(initReactI18next).init({
  resources: { ru: { translation: ru } },
  lng: "ru",
  fallbackLng: "ru",
  interpolation: { escapeValue: false }, // React уже экранирует
  returnEmptyString: false,
});

export function I18nProvider({ children }: { children: ReactNode }) {
  return <>{children}</>;
}

export const useT = useTranslationOrig;
