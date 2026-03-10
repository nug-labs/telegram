import "dotenv/config";
import { NormalizedStrainRepository } from "./core/services/NormalizedStrainRepository";
import { HttpLlmTextAnalysisService } from "./infrastructure/ai/HttpLlmTextAnalysisService";
import type { PasteContentService } from "./infrastructure/http/HttpPastePageFetcher";
import { TelegramBotApp } from "./infrastructure/telegram/TelegramBotApp";
import { JustPasteItContentFetcher } from "./infrastructure/pasteit/JustPasteItContentFetcher";

const botToken = process.env.TELEGRAM_BOT_TOKEN;
const llmApiKey = process.env.OPENAI_API_KEY;
const apiBaseUrl =
  process.env.STRAIN_API_BASE_URL || "https://strains.nuglabs.co";
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
  const strainRepository = new NormalizedStrainRepository(apiBaseUrl);
  const textAnalysisService = new HttpLlmTextAnalysisService(llmApiKey!);
  const pasteContentService: PasteContentService = new JustPasteItContentFetcher();

  const app = new TelegramBotApp({
    botToken: botToken!,
    apiBaseUrl,
    botUsername,
    strainRepository,
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

