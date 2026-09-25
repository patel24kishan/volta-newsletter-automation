import { describe, expect, it } from "vitest";
import { MAC_SCRIPT, nativeNotifier, noopNotifier, notifierFromEnv, WINDOWS_SCRIPT, type Exec } from "../src/reminder/notify.js";

function recorder() {
  const calls: Array<{ file: string; args: string[]; env: NodeJS.ProcessEnv }> = [];
  const exec: Exec = async (file, args, env) => { calls.push({ file, args, env }); };
  return { calls, exec };
}

// A body with everything a shell would love to interpret. It must arrive untouched.
const BODY = 'Good morning. Event "$(rm -rf /)" & `whoami`; it\'s at 6pm';

describe("the desktop notification", () => {
  it("uses each OS's own way, passing the text as environment or argv, never inside a command", async () => {
    const r = recorder();
    await nativeNotifier("win32", r.exec).notify("Title", BODY);
    await nativeNotifier("darwin", r.exec).notify("Title", BODY);
    await nativeNotifier("linux", r.exec).notify("Title", BODY);
    expect(r.calls.map((c) => c.file)).toEqual(["powershell.exe", "osascript", "notify-send"]);
    expect(r.calls[0]!.args).toEqual(["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SCRIPT]);
    expect(r.calls[1]!.args).toEqual(["-e", MAC_SCRIPT]);
    expect(r.calls[2]!.args).toEqual(["Title", BODY]);
    for (const c of r.calls.slice(0, 2)) expect(c.env).toEqual({ VOLTA_NOTIFY_TITLE: "Title", VOLTA_NOTIFY_BODY: BODY });
    // The fixed scripts read the text from the environment and never contain it.
    expect(WINDOWS_SCRIPT).not.toContain("rm -rf");
    expect(WINDOWS_SCRIPT).toContain("$env:VOLTA_NOTIFY_TITLE");
    expect(MAC_SCRIPT).toContain('system attribute "VOLTA_NOTIFY_BODY"');
  });

  it("falls back to a balloon on Windows when the toast types are unavailable", () => {
    expect(WINDOWS_SCRIPT).toMatch(/try \{[\s\S]*ToastNotificationManager[\s\S]*\} catch \{[\s\S]*ShowBalloonTip/);
  });

  it("raises the Windows toast as Claude when Claude is installed, so clicking it opens Claude", () => {
    const order = [WINDOWS_SCRIPT.indexOf("$env:VOLTA_NOTIFY_APPID"), WINDOWS_SCRIPT.indexOf("Get-StartApps"), WINDOWS_SCRIPT.indexOf("WindowsPowerShell")];
    expect(order.every((i) => i >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b)); // a named app first, then Claude's, then PowerShell's
    expect(WINDOWS_SCRIPT).toContain("$_.Name -eq 'Claude'");
    expect(WINDOWS_SCRIPT).toMatch(/CreateToastNotifier\(\$appId\)/);
  });

  it("surfaces a failure as a rejection with a plain reason", async () => {
    const exec: Exec = async () => { throw new Error("notify-send failed: not found"); };
    await expect(nativeNotifier("linux", exec).notify("T", "B")).rejects.toThrow("notify-send failed: not found");
  });

  it("can be switched off for a test or a CI run", async () => {
    expect(notifierFromEnv({ VOLTA_NEWSLETTER_NOTIFIER: "none" })).toBe(noopNotifier);
    const r = recorder();
    await notifierFromEnv({}, "linux", r.exec).notify("T", "B");
    expect(r.calls).toHaveLength(1);
  });
});
