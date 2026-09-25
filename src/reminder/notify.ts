/**
 * A desktop notification from a scheduled run, on hosts that have no scheduler of their own
 * (Cursor, Codex, Claude Code). Each OS's built-in way, nothing installed: a Windows toast from
 * PowerShell, macOS's display notification, notify-send on Linux.
 *
 * The title and body travel as environment variables or argv, never spliced into a shell
 * command: a greeting that mentions an event called "$(rm -rf)" must arrive as text.
 */
import { execFile } from "node:child_process";

export interface Notifier {
  notify(title: string, body: string): Promise<void>;
}

/** Runs a program with the notification text in its environment; rejects with one plain sentence. */
export type Exec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;

export const execNotifier: Exec = (file, args, env) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { env: { ...process.env, ...env }, windowsHide: true, timeout: 30_000 }, (err, _stdout, stderr) => {
      if (err) reject(new Error(`${file} failed: ${(String(stderr) || err.message).trim().split("\n")[0]}`));
      else resolve();
    });
  });

/**
 * Windows: a toast through the WinRT types PowerShell can load on Windows 10 and 11, and when
 * those are unavailable (some policies, Server Core) a tray balloon instead. The script is
 * fixed text; it reads the title and body from the environment.
 *
 * The toast is raised under Claude's own app identity when Claude is installed, so it carries
 * Claude's name and icon and clicking it opens Claude — not a "Windows PowerShell" toast that
 * opens a console. VOLTA_NOTIFY_APPID names another app instead; without either, PowerShell's.
 */
export const WINDOWS_SCRIPT = [
  "$title = $env:VOLTA_NOTIFY_TITLE; $body = $env:VOLTA_NOTIFY_BODY",
  // Whose notification it is: a named app, else Claude's if installed, else PowerShell's own.
  "$appId = $env:VOLTA_NOTIFY_APPID",
  "if (-not $appId) { try { $appId = (Get-StartApps | Where-Object { $_.Name -eq 'Claude' } | Select-Object -First 1).AppID } catch { } }",
  "if (-not $appId) { $appId = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe' }",
  "try {",
  "  [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
  "  [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null",
  "  $xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
  "  $nodes = $xml.GetElementsByTagName('text')",
  "  $nodes.Item(0).AppendChild($xml.CreateTextNode($title)) | Out-Null",
  "  $nodes.Item(1).AppendChild($xml.CreateTextNode($body)) | Out-Null",
  "  [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
  "} catch {",
  "  Add-Type -AssemblyName System.Windows.Forms",
  "  $icon = New-Object System.Windows.Forms.NotifyIcon",
  "  $icon.Icon = [System.Drawing.SystemIcons]::Information",
  "  $icon.Visible = $true",
  "  $icon.ShowBalloonTip(10000, $title, $body, [System.Windows.Forms.ToolTipIcon]::Info)",
  "  Start-Sleep -Seconds 8",
  "  $icon.Dispose()",
  "}",
].join("\n");

export const MAC_SCRIPT = 'display notification (system attribute "VOLTA_NOTIFY_BODY") with title (system attribute "VOLTA_NOTIFY_TITLE")';

export function nativeNotifier(platform: NodeJS.Platform = process.platform, exec: Exec = execNotifier): Notifier {
  return {
    async notify(title, body) {
      const env = { VOLTA_NOTIFY_TITLE: title, VOLTA_NOTIFY_BODY: body };
      if (platform === "win32") return exec("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT], env);
      if (platform === "darwin") return exec("osascript", ["-e", MAC_SCRIPT], env);
      return exec("notify-send", [title, body], env);
    },
  };
}

/** For tests and CI, where a toast on someone's screen is not wanted. */
export const noopNotifier: Notifier = { async notify() { /* nothing */ } };

/** VOLTA_NEWSLETTER_NOTIFIER=none switches notifications off; anything else is the OS's own. */
export function notifierFromEnv(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform, exec?: Exec): Notifier {
  return env.VOLTA_NEWSLETTER_NOTIFIER === "none" ? noopNotifier : nativeNotifier(platform, exec);
}
