/** CDP may omit language on older producers; a reported non-JS language is explicit. */
export const supportsJavaScriptSource = (
  language: string | null | undefined,
): boolean => language == null || language === "JavaScript";
