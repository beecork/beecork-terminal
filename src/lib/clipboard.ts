// Thin, guarded clipboard access. In the Tauri WKWebView these resolve within a
// user gesture (a menu-item click); every call is wrapped so a rejection never
// throws into the UI.

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    /* clipboard unavailable — ignore */
  }
}

export async function readText(): Promise<string> {
  try {
    return await navigator.clipboard.readText();
  } catch {
    return "";
  }
}
