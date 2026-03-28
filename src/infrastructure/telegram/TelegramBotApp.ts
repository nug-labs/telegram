import { NugLabsClient } from "nuglabs";
import { Telegraf, Context } from "telegraf";
import type { TextAnalysisService } from "../../core/contracts/TextAnalysisService";
import type { PasteContentService } from "../../core/contracts/PasteContentService";
import type { Strain } from "../../core/models/Strain";
import type { AppAnalytics } from "../analytics/AppAnalytics";
import type { AnalyticsEventName } from "../analytics/AnalyticsService";
import { GeminiRateLimitError } from "../ai/GeminiTextAnalysisService";
import {
  preparePrimaryStrainLookup,
  normalizeForLooseStrainMatch,
  normalizeForLooseStrainMatchNoSpaces,
} from "../../utils/searchNormalize";

/** Set `true` to restore inline (@bot) strain search. */
const INLINE_QUERY_ENABLED = false;

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

    this.bot.catch((err, ctx) => {
      // eslint-disable-next-line no-console
      console.error("Telegraf middleware error", err);
      this.trackSafe("bot_error", ctx as unknown as Context, {
        area: "telegraf_middleware",
        message: err instanceof Error ? err.message : String(err),
      });
    });

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

    this.bot.on("inline_query", async (ctx) => {
      const iq = ctx as unknown as Context & {
        answerInlineQuery: (results: unknown[], extra?: Record<string, unknown>) => Promise<void>;
      };
      if (!INLINE_QUERY_ENABLED) {
        await iq.answerInlineQuery([], { cache_time: 0, is_personal: true });
        return;
      }
      await this.handleInlineQuery(ctx as unknown as Context & {
        inlineQuery?: { id: string; query: string };
        answerInlineQuery: (results: unknown[], extra?: Record<string, unknown>) => Promise<void>;
      });
    });
  }

  /** Aligns user text with strain names that may contain `#` (e.g. Gelato #33). */
  private normalize(value: string): string {
    return normalizeForLooseStrainMatch(value);
  }

  private normalizeNoSpaces(value: string): string {
    return normalizeForLooseStrainMatchNoSpaces(value);
  }

  /** First-pass lookup string for NugLabs (preserves `#` inside the name). */
  private sanitizeSearchQuery(raw: string): string {
    return preparePrimaryStrainLookup(raw);
  }

  /**
   * Resolves a strain when the catalogue name includes `#` but the user types
   * "gelato 33" / "gelato33" — SDK exact match only sees "gelato #33" vs "gelato 33".
   */
  private async resolveStrain(raw: string): Promise<Strain | null> {
    const primary = this.sanitizeSearchQuery(raw);
    if (!primary) return null;

    let strain = (await this.config.strainClient.getStrain(primary)) as Strain | null;
    if (strain) return strain;

    const target = normalizeForLooseStrainMatch(raw);
    const targetNoSpace = normalizeForLooseStrainMatchNoSpaces(raw);
    if (!target && !targetNoSpace) return null;

    const allStrains = (await this.config.strainClient.getAllStrains()) as Strain[];
    for (const candidate of allStrains) {
      const labels: string[] = [candidate.name];
      const akas = Array.isArray((candidate as any).akas) ? ((candidate as any).akas as unknown[]) : [];
      for (const a of akas) {
        if (typeof a === "string") labels.push(a);
      }
      for (const label of labels) {
        if (normalizeForLooseStrainMatch(label) === target) return candidate;
        if (normalizeForLooseStrainMatchNoSpaces(label) === targetNoSpace) return candidate;
      }
    }
    return null;
  }

  private computeInlineScore(query: string, candidate: string): number {
    const q = this.normalize(query);
    const c = this.normalize(candidate);
    if (!q || !c) return 0;

    const qNoSpace = this.normalizeNoSpaces(q);
    const cNoSpace = this.normalizeNoSpaces(c);

    if (q === c) return 100;
    if (qNoSpace === cNoSpace) return 95;
    if (c.startsWith(q)) return 80;
    if (cNoSpace.startsWith(qNoSpace)) return 75;
    if (c.includes(q)) return 60;
    if (cNoSpace.includes(qNoSpace)) return 55;

    const qTokens = new Set(q.split(/\s+/).filter(Boolean));
    const cTokens = new Set(c.split(/\s+/).filter(Boolean));
    if (qTokens.size === 0 || cTokens.size === 0) return 0;

    let overlap = 0;
    for (const token of qTokens) {
      if (cTokens.has(token)) overlap += 1;
    }

    return overlap > 0 ? Math.floor((overlap / qTokens.size) * 40) : 0;
  }

  private rankInlineMatches(query: string, strains: Strain[]): Strain[] {
    const scored = strains
      .map((strain) => {
        const aliases = Array.isArray((strain as any).akas) ? ((strain as any).akas as unknown[]) : [];
        const aliasStrings = aliases.filter((a): a is string => typeof a === "string");
        const nameScore = this.computeInlineScore(query, strain.name);
        const aliasScore = aliasStrings.reduce(
          (best, alias) => Math.max(best, this.computeInlineScore(query, alias)),
          0
        );

        // Slightly prefer primary-name hits over alias-only hits.
        const score = Math.max(nameScore, aliasScore) + (nameScore > 0 ? 2 : 0);
        return { strain, score };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score || a.strain.name.localeCompare(b.strain.name));

    return scored.slice(0, 2).map((item) => item.strain);
  }

  private getInlineDescription(strain: Strain): string {
    const description =
      (strain as any).description_sm ??
      (strain as any).description_md ??
      (strain as any).description_lg ??
      "";
    const text = String(description ?? "").replace(/\s+/g, " ").trim();
    if (!text) return "View details";
    return text.length > 80 ? `${text.slice(0, 80).trimEnd()}…` : text;
  }

  private formatInlineSelection(strainName: string): string {
    const words = strainName
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
    const noSpaces = words.join("");
    return `${noSpaces}@${this.config.botUsername}`;
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
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
    const q = this.sanitizeSearchQuery(query);
    if (!q) {
      await ctx.reply("Please send a strain name.");
      this.trackSafe("bot_empty_query", ctx);
      return;
    }

    const strain = await this.resolveStrain(query);
    if (!strain) {
      await ctx.reply("Strain not found.");
      this.trackSafe("bot_strain_not_found", ctx, { query: q });
      return;
    }

    const text = this.formatStrain(strain);
    const deepLink = this.buildDeepLink(strain.name);

    // Use Markdown so keys stay bold, but keep the deep link as plain text.
    await ctx.replyWithMarkdown(`${text}\n\n${deepLink}`);
    this.trackSafe("bot_strain_found", ctx, { query: q, strainName: strain.name });
  }

  private async handleInlineQuery(
    ctx: Context & {
      inlineQuery?: { id: string; query: string };
      answerInlineQuery: (results: unknown[], extra?: Record<string, unknown>) => Promise<void>;
    }
  ): Promise<void> {
    try {
      const query = this.sanitizeSearchQuery(ctx.inlineQuery?.query || "");
      if (!query) {
        await ctx.answerInlineQuery([], { cache_time: 60, is_personal: false });
        return;
      }

      const allStrains = (await this.config.strainClient.getAllStrains()) as Strain[];
      const topMatches = this.rankInlineMatches(query, allStrains);
      this.trackSafe("bot_inline_query", ctx, {
        query,
        queryLength: query.length,
        resultCount: topMatches.length,
      });

      const results = topMatches.map((strain, index) => {
        const deepLink = this.buildDeepLink(strain.name);
        const description = this.getInlineDescription(strain);
        const selection = this.formatInlineSelection(strain.name);
        const label = this.escapeHtml(selection);
        const href = this.escapeHtml(deepLink);

        return {
          type: "article",
          id: `${strain.name}-${index}-${Date.now()}`,
          title: strain.name,
          description,
          input_message_content: {
            message_text: `<a href="${href}">${label}</a>`,
            parse_mode: "HTML",
          },
        };
      });

      await ctx.answerInlineQuery(results, {
        cache_time: 60,
        is_personal: false,
      });
    } catch (err) {
      console.error("Failed to process inline query", err);
      this.trackSafe("bot_error", ctx, {
        area: "inline_query",
        message: err instanceof Error ? err.message : String(err),
      });
      await ctx.answerInlineQuery([], { cache_time: 1, is_personal: true });
    }
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
        const strain = await this.resolveStrain(name);
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

