/**
 * Fail loudly (constraint 8). Every alert names the source, what failed, and what to do.
 * Demo: console plus out/alerts.log. Production: a Slack adapter behind the same interface.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AlertLevel = "error" | "warning" | "info";

export interface Alert {
  level: AlertLevel;
  source: string;
  message: string;
  action: string;
  at: string;
}

export interface Alerter {
  alert(level: AlertLevel, source: string, message: string, action: string): void;
  readonly sent: Alert[];
}

export class ConsoleFileAlerter implements Alerter {
  readonly sent: Alert[] = [];
  constructor(private readonly logPath: string, private readonly now: () => Date = () => new Date(), private readonly quiet = false) {
    mkdirSync(dirname(logPath), { recursive: true });
  }

  alert(level: AlertLevel, source: string, message: string, action: string): void {
    const a: Alert = { level, source, message, action, at: this.now().toISOString() };
    this.sent.push(a);
    const line = `${a.at} ${level.toUpperCase().padEnd(7)} [${source}] ${message} -> ${action}`;
    appendFileSync(this.logPath, line + "\n", "utf8");
    if (!this.quiet) (level === "error" ? console.error : console.log)(line);
  }
}

export class MemoryAlerter implements Alerter {
  readonly sent: Alert[] = [];
  alert(level: AlertLevel, source: string, message: string, action: string): void {
    this.sent.push({ level, source, message, action, at: new Date(0).toISOString() });
  }
}
