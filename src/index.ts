import "dotenv/config";
import { NugLabsClient } from "nuglabs";
import { OpenAiTextAnalysisService } from "./infrastructure/ai/OpenAiTextAnalysisService";
import type { PasteContentService } from "./core/contracts/PasteContentService";
import { TelegramBotApp } from "./infrastructure/telegram/TelegramBotApp";
import { JustPasteItPasteContentService } from "./infrastructure/pasteit/JustPasteItPasteContentService";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const llmApiKey = process.env.OPENAI_API_KEY;
const apiBaseUrl = process.env.STRAIN_API_BASE_URL?.trim();
const botUsername =
  process.env.TELEGRAM_BOT_USERNAME || "StrainIndexBot";

if (!botToken) {
  // eslint-disable-next-line no-console
  console.error("TELEGRAM_BOT_TOKEN is required");
  process.exit(1);
}

if (!llmApiKey) {
  // eslint-disable-next-line no-console
  console.error("OPENAI_API_KEY is required for text analysis");
  process.exit(1);
}

async function main() {
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

  // TODO: Move this behavior into SDK initialization, so consumers do not need to manually refresh on startup.
  // For now, force a sync on bot boot so newly deployed API data is available immediately.
  try {
    const sync = await strainClient.forceResync();
    // eslint-disable-next-line no-console
    console.log(
      `NugLabs sync completed. source=${sync.source} count=${sync.count} updatedAt=${sync.updatedAt}`
    );
  } catch (error) {
    // eslint-disable-next-line no-console
    console.warn("NugLabs startup sync failed, continuing with local dataset.", error);
  }

  const textAnalysisService = new OpenAiTextAnalysisService(llmApiKey!);
  const pasteContentService: PasteContentService = new JustPasteItPasteContentService();

  const app = new TelegramBotApp({
    botToken: botToken!,
    botUsername,
    strainClient,
    textAnalysisService,
    pasteContentService,
  });

  await app.init();
  app.launch();

  // eslint-disable-next-line no-console
  console.log("Telegram strain bot is running.");
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Fatal error starting Telegram bot", err);
  process.exit(1);
});

