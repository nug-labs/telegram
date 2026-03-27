import type { AnalyticsEventName, AnalyticsService } from "./AnalyticsService";

type AnalyticsLevel = "info" | "warn" | "error";

interface TelegramContext {
  chatId?: number;
  fromId?: number;
  username?: string;
  messageId?: number;
}

interface LogOptions {
  telegram?: TelegramContext;
  props?: Record<string, unknown>;
}

export class AppAnalytics {
  constructor(
    private readonly analyticsService?: AnalyticsService,
    private readonly baseProps: Record<string, unknown> = {}
  ) {}

  child(props: Record<string, unknown>): AppAnalytics {
    return new AppAnalytics(this.analyticsService, {
      ...this.baseProps,
      ...props,
    });
  }

  info(name: AnalyticsEventName, options?: LogOptions): void {
    this.emit("info", name, options);
  }

  warn(name: AnalyticsEventName, options?: LogOptions): void {
    this.emit("warn", name, options);
  }

  error(name: AnalyticsEventName, options?: LogOptions): void {
    this.emit("error", name, options);
  }

  private emit(level: AnalyticsLevel, name: AnalyticsEventName, options?: LogOptions): void {
    if (!this.analyticsService) return;

    this.analyticsService
      .track({
        name,
        at: new Date(),
        telegram: options?.telegram,
        props: {
          level,
          ...this.baseProps,
          ...(options?.props ?? {}),
        },
      })
      .catch((err) => {
        // Keep telemetry failures non-blocking.
        console.warn("Analytics emit failed", err);
      });
  }
}

