import axios from "axios";
import https from "node:https";
import type { PasteContentService } from "../../core/contracts/PasteContentService";
import type { AppAnalytics } from "../analytics/AppAnalytics";

// Support both the full domain and the short jpst.it links
const JUSTPASTE_REGEX =
  /https?:\/\/(?:www\.)?(?:justpaste\.it|jpst\.it)\/\S+/i;

/**
 * JustPasteIt-specific implementation of PasteContentService.
 */
export class JustPasteItPasteContentService implements PasteContentService {
  constructor(private readonly analytics?: AppAnalytics) {}

  extractUrlFromText(text: string): string | null {
    const match = text.match(JUSTPASTE_REGEX);
    if (!match) return null;
    // Telegram messages often wrap links with punctuation/formatting.
    return match[0].replace(/[)\].,!?]+$/g, "");
  }

  async fetchText(url: string): Promise<string> {
    const startedAt = Date.now();
    this.analytics?.info("paste_fetch_start", { props: { url } });
    try {
      const httpsAgent = new https.Agent({
        keepAlive: true,
        // Some environments stall on IPv6 routes; prefer IPv4.
        family: 4,
      });

      const requestConfig = {
        timeout: 30000,
        maxRedirects: 5,
        httpsAgent,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; NugLabsTelegramBot/1.0)",
          Accept: "text/html,application/xhtml+xml",
        },
      } as const;

      const fetchHtml = async (): Promise<string> => {
        const res = await axios.get<string>(url, requestConfig);
        return res.data;
      };

      let html: string;
      try {
        html = await fetchHtml();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 750));
        html = await fetchHtml();
      }
      // Very simple HTML -> text extraction
      const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");
      const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, "");
      const text = withoutStyles.replace(/<[^>]+>/g, " ");
      const normalized = text.replace(/\s+/g, " ").trim();
      this.analytics?.info("paste_fetch_success", {
        props: { url, durationMs: Date.now() - startedAt, textLength: normalized.length },
      });
      return normalized;
    } catch (err) {
      this.analytics?.error("paste_fetch_failed", {
        props: {
          url,
          durationMs: Date.now() - startedAt,
          message: err instanceof Error ? err.message : String(err),
        },
      });
      throw err;
    }
  }
}
