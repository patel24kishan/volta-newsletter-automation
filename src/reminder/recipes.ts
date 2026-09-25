/**
 * How to make the reminder run by itself on a host with no scheduler of its own. One recipe per
 * OS, used by newsletter_status (one line, when it has never run) and by the README (in full).
 * The task runs every day because it cannot know which day is the month's first workday;
 * `monthly_reminder` decides that and stays quiet on every other day.
 */
export const REMINDER_TIME = "08:35";
export const REMINDER_COMMAND = "npx -y volta-newsletter reminder";

export interface Recipe {
  platform: "win32" | "darwin" | "linux";
  /** What it is called on that OS. */
  scheduler: string;
  /** The command or file that sets it up, ready to paste. */
  setup: string;
  /** One sentence for newsletter_status. */
  oneLine: string;
}

const LAUNCHD_PLIST = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.volta-newsletter.reminder</string>
  <key>ProgramArguments</key><array><string>/bin/sh</string><string>-lc</string><string>${REMINDER_COMMAND}</string></array>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>8</integer><key>Minute</key><integer>35</integer></dict>
</dict></plist>`;

export const RECIPES: Record<Recipe["platform"], Recipe> = {
  win32: {
    platform: "win32",
    scheduler: "Task Scheduler",
    setup: `schtasks /Create /SC DAILY /ST ${REMINDER_TIME} /TN "Volta newsletter reminder" /TR "cmd /c ${REMINDER_COMMAND}"`,
    oneLine: `Set it up with one command in PowerShell: schtasks /Create /SC DAILY /ST ${REMINDER_TIME} /TN "Volta newsletter reminder" /TR "cmd /c ${REMINDER_COMMAND}"`,
  },
  darwin: {
    platform: "darwin",
    scheduler: "launchd",
    setup: `Save this as ~/Library/LaunchAgents/com.volta-newsletter.reminder.plist, then run: launchctl load ~/Library/LaunchAgents/com.volta-newsletter.reminder.plist\n\n${LAUNCHD_PLIST}`,
    oneLine: `Set it up with a launchd agent that runs "${REMINDER_COMMAND}" at ${REMINDER_TIME} every day (the README has the file to save).`,
  },
  linux: {
    platform: "linux",
    scheduler: "cron",
    setup: `crontab -e, then add the line:\n35 8 * * * ${REMINDER_COMMAND}`,
    oneLine: `Set it up with a cron line: 35 8 * * * ${REMINDER_COMMAND}`,
  },
};

export function recipeFor(platform: NodeJS.Platform): Recipe {
  return platform === "win32" ? RECIPES.win32 : platform === "darwin" ? RECIPES.darwin : RECIPES.linux;
}
