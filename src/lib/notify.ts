import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";

let granted = false;

/** Ask once (at startup) so later notifications can fire without a prompt. */
export async function initNotifications() {
  try {
    granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
  } catch {
    granted = false;
  }
}

/** Fire an OS notification (no-op if permission wasn't granted). */
export function notify(title: string, body?: string) {
  if (!granted) return;
  try {
    sendNotification({ title, body });
  } catch {
    /* ignore */
  }
}
