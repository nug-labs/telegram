import { Telegraf, Context } from "telegraf";
import type { StrainRepository } from "../../core/ports/StrainRepository";
import type { TextAnalysisService } from "../../core/ports/TextAnalysisService";
import type { PasteContentService } from "../http/HttpPastePageFetcher";
import type { Strain } from "../../core/StrainTypes";

export interface BotConfig {
  botToken: string;
  apiBaseUrl: string;
  botUsername: string;
  strainRepository: StrainRepository;
  textAnalysisService: TextAnalysisService;
  pasteContentService: PasteContentService;
}

export class TelegramBotApp {
  private readonly bot: Telegraf<Context>;
  private readonly config: BotConfig;

  constructor(config: BotConfig) {
    this.config = config;
    this.bot = new Telegraf<Context>(config.botToken);
    this.registerHandlers();
  }

  async init(): Promise<void> {
    await this.config.strainRepository.refresh();
    // refresh every 12 hours
    setInterval(
      () => this.config.strainRepository.refresh().catch(console.error),
      12 * 60 * 60 * 1000
    );
  }

  launch(): void {
    this.bot.launch().catch((err) => {
      console.error("Failed to launch Telegram bot", err);
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
    });

    this.bot.on("text", async (ctx) => {
      const text = ctx.message.text.trim();
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

    const thcRaw = get("thc");
    let thcDisplay: string | null = null;
    if (typeof thcRaw === "number") {
      thcDisplay = `${thcRaw}%`;
    } else if (typeof thcRaw === "string" && thcRaw.trim()) {
      thcDisplay = thcRaw;
    }

    // Header: name / type / THC / also known as
    pushIf("Name", strain.name);
    pushIf("AKA", get("akas"));
    if (lines.length > 0) lines.push(""); // blank line

    pushIf("Type", get("type"));
    if (thcDisplay) {
      pushIf("THC", thcDisplay);
    }
    if (lines.length > 0) lines.push(""); // blank line

    // Chemical / flavor / effects block
    pushIf("Flavours", get("flavors"));
    pushIf("Terpenes", get("detailed_terpenes"));
    if (lines.length > 0) lines.push(""); // blank line

    pushIf("Effects", get("positive_effects"));
    pushIf("Helps with", get("helps_with"));
    if (lines[lines.length - 1] !== "") lines.push("");

    // Description last
    pushIf("Description", get("description"));

    return lines.join("\n");
  }

  private async handleStrainQuery(ctx: Context, query: string): Promise<void> {
    if (!query.trim()) {
      await ctx.reply("Please send a strain name.");
      return;
    }

    const match = this.config.strainRepository.findByNameOrAka(query);
    if (!match) {
      await ctx.reply("Strain not found.");
      return;
    }

    const text = this.formatStrain(match.strain);
    const deepLink = this.buildDeepLink(match.strain.name);

    // Use Markdown so keys stay bold, but keep the deep link as plain text.
    await ctx.replyWithMarkdown(`${text}\n\n${deepLink}`);
  }

  private async handlePasteLink(ctx: Context, url: string): Promise<void> {
    try {
      const text = await this.config.pasteContentService.fetchText(url);
      const allStrains = this.config.strainRepository.getAll();
      const knownNames = allStrains.map((s) => s.name);

      const mentionedNames = await this.config.textAnalysisService.extractKnownNames(
        text,
        knownNames
      );

      const uniqueNames = Array.from(new Set(mentionedNames));
      if (uniqueNames.length === 0) {
        await ctx.reply(
          "I couldn't find any known strains in that link's content."
        );
        return;
      }

      const found: { name: string; link: string }[] = [];
      for (const name of uniqueNames) {
        const match = this.config.strainRepository.findByNameOrAka(name);
        if (match) {
          found.push({
            name: match.strain.name,
            link: this.buildDeepLink(match.strain.name),
          });
        }
      }

      if (found.length === 0) {
        await ctx.reply(
          "I couldn't match any strains from that link to my current strain list."
        );
        return;
      }

      const lines = found.flatMap((f) => [f.name, f.link, ""]);
      await ctx.reply(
        `I found these strains in the paste:\n\n${lines.join("\n")}`.trim()
      );
    } catch (err) {
      console.error("Failed to process paste link", err);
      await ctx.reply("Sorry, I couldn't read that link.");
    }
  }
}

