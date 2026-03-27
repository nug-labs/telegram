import { NugLabsClient } from "nuglabs";
import { Telegraf, Context } from "telegraf";
import type { TextAnalysisService } from "../../core/contracts/TextAnalysisService";
import type { PasteContentService } from "../../core/contracts/PasteContentService";
import type { Strain } from "../../core/models/Strain";
import type { AppAnalytics } from "../analytics/AppAnalytics";
import type { AnalyticsEventName } from "../analytics/AnalyticsService";
import { GeminiRateLimitError } from "../ai/GeminiTextAnalysisService";

export interface BotConfig {
  botToken: string;
  botUsername: string;
  strainClient: NugLabsClient;
  textAnalysisService: TextAnalysisService;
  pasteContentService: PasteContentService;
  analytics?: AppAnalytics;
}

export class TelegramBotApp {
  private readonly bot: Telegraf<Context>;
  private readonly config: BotConfig;
  private readonly analytics?: AppAnalytics;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new Telegraf<Context>(config.botToken);
    this.analytics = config.analytics?.child({ component: "telegram_bot" });
    this.registerHandlers();
  }

  async init(): Promise<void> {
    await this.config.strainClient.initialize();
  }

  launch(): void {
    this.bot.launch().catch((err) => {
      console.error("Failed to launch Telegram bot", err);
      this.analytics?.error("telegram_launch_failed", {
        props: { message: err instanceof Error ? err.message : String(err) },
      });
      process.exit(1);
    });
  }

  private registerHandlers(): void {
    this.bot.start(async (ctx) => {
      const payload = (ctx.startPayload || "").trim();
      if (payload) {
        const query = decodeURIComponent(payload.replace(/-/g, " "));
        await this.handleStrainQuery(ctx, query);
      } else {
        await ctx.reply(
          'Send me a strain name (e.g. "Mimosa") and I\'ll look up details for you.'
        );
      }

      this.trackSafe("bot_start", ctx, {
        hasStartPayload: Boolean(payload),
      });
    });

    this.bot.on("text", async (ctx) => {
      const text = ctx.message.text.trim();
      this.trackSafe("bot_text_query", ctx, {
        textLength: text.length,
      });
      const pasteUrl = this.config.pasteContentService.extractUrlFromText(text);
      if (pasteUrl) {
        await this.handlePasteLink(ctx, pasteUrl);
        return;
      }

      await this.handleStrainQuery(ctx, text);
    });
  }

  private buildDeepLink(strainName: string): string {
    const payload = encodeURIComponent(
      strainName.toLowerCase().replace(/\s+/g, "-")
    );
    return `https://t.me/${this.config.botUsername}?start=${payload}`;
  }

  private formatStrain(strain: Strain): string {
    const lines: string[] = [];

    const get = (key: string): unknown => (strain as any)[key] ?? undefined;

    const pushIf = (label: string, value: unknown) => {
      if (value === null || value === undefined) return;
      let text: string;
      if (Array.isArray(value)) {
        text = value.join(", ");
      } else {
        text = String(value);
      }
      if (!text.trim()) return;
      lines.push(`*${label}:* ${text}`);
    };

    const pushBlankLineIfSectionPrinted = (beforeLen: number) => {
      if (lines.length <= beforeLen) return;
      if (lines[lines.length - 1] === "") return;
      lines.push("");
    };

    const limitArray = (value: unknown, max = 3): unknown => {
      if (!Array.isArray(value)) return value;
      return value.slice(0, max);
    };

    const thcRaw = get("thc");
    const thcDisplay =
      typeof thcRaw === "number" ? `${thcRaw}%` : null;

    // Header: name / type / THC / also known as
    const headerBefore = lines.length;
    pushIf("Name", strain.name);
    pushIf("AKA", get("akas"));
    pushBlankLineIfSectionPrinted(headerBefore);

    const typeBefore = lines.length;
    pushIf("Type", get("type"));
    if (thcDisplay) {
      pushIf("Averaging", `THC ${thcDisplay}`);
    }
    pushBlankLineIfSectionPrinted(typeBefore);

    // Chemical / flavour / effects block
    const flavourBefore = lines.length;
    pushIf("Flavours", limitArray(get("flavours")));
    pushIf("Aromas", limitArray(get("aromas")));
    pushBlankLineIfSectionPrinted(flavourBefore);

    const terpeneBefore = lines.length;
    pushIf("Terpenes", limitArray(get("terpenes")));
    pushBlankLineIfSectionPrinted(terpeneBefore);

    const effectsBefore = lines.length;
    pushIf("Effects", limitArray(get("effects")));
    pushIf("Helps with", limitArray(get("helps_with")));
    pushBlankLineIfSectionPrinted(effectsBefore);

    // Description last (prefer short summary from new dataset shape)
    const description =
      get("description_sm") ??
      get("description_md") ??
      get("description_lg");
    pushIf("Description", description);

    return lines.join("\n");
  }

  private async handleStrainQuery(ctx: Context, query: string): Promise<void> {
    if (!query.trim()) {
      await ctx.reply("Please send a strain name.");
      this.trackSafe("bot_empty_query", ctx);
      return;
    }

    const strain = (await this.config.strainClient.getStrain(query)) as Strain | null;
    if (!strain) {
      await ctx.reply("Strain not found.");
      this.trackSafe("bot_strain_not_found", ctx, { query });
      return;
    }

    const text = this.formatStrain(strain);
    const deepLink = this.buildDeepLink(strain.name);

    // Use Markdown so keys stay bold, but keep the deep link as plain text.
    await ctx.replyWithMarkdown(`${text}\n\n${deepLink}`);
    this.trackSafe("bot_strain_found", ctx, { query, strainName: strain.name });
  }

  private async handlePasteLink(ctx: Context, url: string): Promise<void> {
    try {
      this.trackSafe("bot_paste_link", ctx, { url });
      const text = await this.config.pasteContentService.fetchText(url);
      const mentionedNames = await this.config.textAnalysisService.extractStrainNames(text);
      const uniqueNames = Array.from(
        new Set(
          mentionedNames
            .map((name) => name.trim())
            .filter(Boolean)
        )
      );
      if (uniqueNames.length === 0) {
        await ctx.reply(
          "I couldn't find any strain names in that link's content."
        );
        this.trackSafe("bot_paste_match_none", ctx, { url });
        return;
      }

      const found: { name: string; link: string }[] = [];
      const notFound: string[] = [];
      for (const name of uniqueNames) {
        const strain = (await this.config.strainClient.getStrain(name)) as Strain | null;
        if (strain) {
          found.push({
            name: strain.name,
            link: this.buildDeepLink(strain.name),
          });
        } else {
          notFound.push(name);
        }
      }

      if (found.length === 0) {
        await ctx.reply(
          "I couldn't match any strains from that link to my current strain list."
        );
        this.trackSafe("bot_paste_match_none", ctx, { url, mentionedCount: uniqueNames.length });
        return;
      }

      const foundLines = found.flatMap((f) => [f.name, f.link, ""]).join("\n").trim();
      const notFoundSection =
        notFound.length > 0
          ? `\n\nNot found:\n${Array.from(new Set(notFound)).map((n) => `- ${n}`).join("\n")}`
          : "";

      await ctx.reply(`I found these strains in the paste:\n\n${foundLines}${notFoundSection}`.trim());
      this.trackSafe("bot_paste_matched", ctx, { url, count: found.length, notFoundCount: notFound.length });
    } catch (err) {
      if (err instanceof GeminiRateLimitError) {
        const retry = typeof err.retryAfterSeconds === "number" ? ` Please retry in ~${err.retryAfterSeconds}s.` : "";
        await ctx.reply(`Gemini is rate-limiting requests right now.${retry}`);
        this.trackSafe("bot_error", ctx, {
          area: "gemini_rate_limit",
          message: err.message,
          retryAfterSeconds: err.retryAfterSeconds,
        });
        return;
      }

      console.error("Failed to process paste link", err);
      this.trackSafe("bot_error", ctx, {
        area: "paste_link",
        message: err instanceof Error ? err.message : String(err),
      });
      await ctx.reply("Sorry, I couldn't read that link.");
    }
  }

  private trackSafe(
    name: AnalyticsEventName,
    ctx: Context,
    props?: Record<string, unknown>
  ): void {
    const analytics = this.analytics;
    if (!analytics) return;

    const message: any = (ctx as any).message;
    const from = message?.from;
    const chat = message?.chat;

    analytics.info(name, {
      telegram: {
        chatId: typeof chat?.id === "number" ? chat.id : undefined,
        fromId: typeof from?.id === "number" ? from.id : undefined,
        username: typeof from?.username === "string" ? from.username : undefined,
        messageId: typeof message?.message_id === "number" ? message.message_id : undefined,
      },
      props,
    });
  }
}

