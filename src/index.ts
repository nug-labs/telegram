import "dotenv/config";
import { NugLabsClient } from "nuglabs";
import { GeminiTextAnalysisService } from "./infrastructure/ai/GeminiTextAnalysisService";
import type { PasteContentService } from "./core/contracts/PasteContentService";
import { TelegramBotApp } from "./infrastructure/telegram/TelegramBotApp";
import { JustPasteItPasteContentService } from "./infrastructure/pasteit/JustPasteItPasteContentService";
import { getSupabasePool } from "./infrastructure/supabase/supabase-db";
import { bootstrapAnalytics } from "./infrastructure/analytics/bootstrapAnalytics";
import { AnalyticsService } from "./infrastructure/analytics/AnalyticsService";
import { AppAnalytics } from "./infrastructure/analytics/AppAnalytics";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const llmApiKey = process.env.GEMINI_API_KEY;
const apiBaseUrl = process.env.STRAIN_API_BASE_URL?.trim();
const botUsername =
  process.env.TELEGRAM_BOT_USERNAME || "StrainIndexBot";
const enableAnalytics = (process.env.ENABLE_ANALYTICS || "").toLowerCase() === "true";

if (!botToken) {
  // eslint-disable-next-line no-console
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!llmApiKey) {
  // eslint-disable-next-line no-console
  console.error("GEMINI_API_KEY is required for text analysis");
  process.exit(1);
}

async function main() {
  let appAnalytics: AppAnalytics | undefined;
  const bootStartedAt = Date.now();

  const strainClient = new NugLabsClient(
    apiBaseUrl
      ? {
          apiBaseUrl,
          cacheInMemory: true,
        }
      : {
          cacheInMemory: true,
        }
  );

  let analyticsService: AnalyticsService | undefined;
  if (enableAnalytics) {
    try {
      const db = getSupabasePool();
      await bootstrapAnalytics(db);
      analyticsService = new AnalyticsService(db);
      appAnalytics = new AppAnalytics(analyticsService, {
        service: "telegram_bot",
      });
      appAnalytics.info("app_boot_start");
      // eslint-disable-next-line no-console
      console.log("Analytics enabled (Supabase Postgres).");
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("Analytics failed to initialize while ENABLE_ANALYTICS=true.", err);
      throw err;
    }
  }

  // TODO: Move this behavior into SDK initialization, so consumers do not need to manually refresh on startup.
  // For now, force a sync on bot boot so newly deployed API data is available immediately.
  try {
    const sync = await strainClient.forceResync();
    appAnalytics?.info("strain_sync_success", {
      props: {
        source: sync.source,
        count: sync.count,
        updatedAt: sync.updatedAt,
      },
    });
    // eslint-disable-next-line no-console
    console.log(
      `NugLabs sync completed. source=${sync.source} count=${sync.count} updatedAt=${sync.updatedAt}`
    );
  } catch (error) {
    appAnalytics?.warn("strain_sync_failed", {
      props: { message: error instanceof Error ? error.message : String(error) },
    });
    // eslint-disable-next-line no-console
    console.warn("NugLabs startup sync failed, continuing with local dataset.", error);
  }

  const textAnalysisService = new GeminiTextAnalysisService(llmApiKey!, "gemini-2.5-flash", appAnalytics);
  const pasteContentService: PasteContentService = new JustPasteItPasteContentService(appAnalytics);

  const app = new TelegramBotApp({
    botToken: botToken!,
    botUsername,
    strainClient,
    textAnalysisService,
    pasteContentService,
    analytics: appAnalytics,
  });

  await app.init();
  app.launch();
  appAnalytics?.info("app_boot_ready", {
    props: { durationMs: Date.now() - bootStartedAt },
  });

  // eslint-disable-next-line no-console
  console.log("Telegram strain bot is running.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting Telegram bot", err);
  process.exit(1);
});

