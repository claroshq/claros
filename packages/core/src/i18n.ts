/**
 * Strings of the mail footer and the public unsubscribe pages, per product
 * locale (G22). English is the default; a locale is matched by its language
 * ("es-MX" uses "es"). Add a language by adding a complete entry.
 */
export interface PublicStrings {
  footerUnsubscribeLink: string;
  footerUnsubscribeRest: string;
  footerTextUnsubscribe: string;
  pageUnsubscribeTitle: string;
  pageUnsubscribeBody: string;
  pageUnsubscribeButton: string;
  pagePreferencesTitle: string;
  pagePreferencesBody: string;
  pageSave: string;
  pageUnsubscribeAll: string;
  pageSavedTitle: string;
  pageSavedBody: string;
  pageDoneTitle: string;
  pageDoneTopic: string;
  pageDoneAll: string;
  pageInvalidTitle: string;
  pageInvalidBody: string;
}

export const PUBLIC_STRINGS: Record<string, PublicStrings> = {
  en: {
    footerUnsubscribeLink: "Unsubscribe",
    footerUnsubscribeRest: " from these emails.",
    footerTextUnsubscribe: "Unsubscribe",
    pageUnsubscribeTitle: "Unsubscribe",
    pageUnsubscribeBody: "Click the button below to unsubscribe and stop receiving emails from this sender.",
    pageUnsubscribeButton: "Unsubscribe me",
    pagePreferencesTitle: "Email preferences",
    pagePreferencesBody: "Choose which emails you want to receive, or unsubscribe from all emails from this sender.",
    pageSave: "Save preferences",
    pageUnsubscribeAll: "Unsubscribe from all",
    pageSavedTitle: "Preferences saved",
    pageSavedBody: "Your email preferences were updated.",
    pageDoneTitle: "Unsubscribed",
    pageDoneTopic: "You have been unsubscribed from this type of email. Other emails from this sender are not affected.",
    pageDoneAll: "You have been unsubscribed. You will no longer receive emails from this sender.",
    pageInvalidTitle: "Invalid link",
    pageInvalidBody: "This unsubscribe link is invalid. It may have been corrupted or is no longer valid.",
  },
  es: {
    footerUnsubscribeLink: "Darse de baja",
    footerUnsubscribeRest: " de estos correos.",
    footerTextUnsubscribe: "Darse de baja",
    pageUnsubscribeTitle: "Darse de baja",
    pageUnsubscribeBody: "Haz clic en el botón para darte de baja y dejar de recibir correos de este remitente.",
    pageUnsubscribeButton: "Darme de baja",
    pagePreferencesTitle: "Preferencias de correo",
    pagePreferencesBody: "Elige qué correos quieres recibir o date de baja de todos los correos de este remitente.",
    pageSave: "Guardar preferencias",
    pageUnsubscribeAll: "Darme de baja de todo",
    pageSavedTitle: "Preferencias guardadas",
    pageSavedBody: "Tus preferencias de correo se han actualizado.",
    pageDoneTitle: "Baja confirmada",
    pageDoneTopic: "Te has dado de baja de este tipo de correo. Los demás correos de este remitente no cambian.",
    pageDoneAll: "Te has dado de baja. Ya no recibirás correos de este remitente.",
    pageInvalidTitle: "Enlace no válido",
    pageInvalidBody: "Este enlace para darse de baja no es válido. Puede estar dañado o haber caducado.",
  },
};

/** The language code used for a locale ("es-MX" -> "es"), "en" when unsupported. */
export function publicLanguage(locale: string | null | undefined): string {
  const lang = (locale ?? "").toLowerCase().split("-")[0] ?? "";
  return lang in PUBLIC_STRINGS ? lang : "en";
}

export function publicStrings(locale: string | null | undefined): PublicStrings {
  return PUBLIC_STRINGS[publicLanguage(locale)]!;
}
