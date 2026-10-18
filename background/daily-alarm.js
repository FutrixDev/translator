// Blab Translation — a daily alarm that keeps its schedule.
//
// chrome.alarms.create() replaces an alarm of the same name and starts its
// period over. onInstalled and onStartup run on every update and every browser
// start, so creating the alarm there unconditionally pushes its next run a day
// past each start: a browser opened every morning would never reach it. The
// alarm is created only when chrome.alarms has none by that name (D-609).
export async function ensureDailyAlarm(name) {
  if (await chrome.alarms.get(name)) return;
  await chrome.alarms.create(name, { periodInMinutes: 24 * 60 });
}
