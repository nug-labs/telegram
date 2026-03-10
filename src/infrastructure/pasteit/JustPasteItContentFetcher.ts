import axios from "axios";
import type { PasteContentService } from "../http/HttpPastePageFetcher";

// Support both the full domain and the short jpst.it links
const JUSTPASTE_REGEX =
  /https?:\/\/(?:www\.)?(?:justpaste\.it|jpst\.it)\/\S+/i;

/**
 * JustPasteIt-specific implementation of PasteContentService.
 * This file is gitignored so the vendor-specific wiring is not part of the public repo.
 */
export class JustPasteItContentFetcher implements PasteContentService {
  extractUrlFromText(text: string): string | null {
    const match = text.match(JUSTPASTE_REGEX);
    return match ? match[0] : null;
  }

  async fetchText(url: string): Promise<string> {
    const res = await axios.get<string>(url, { timeout: 15000 });
    const html = res.data;
    // Very simple HTML -> text extraction
    const withoutScripts = html.replace(/<script[\s\S]*?<\/script>/gi, "");
    const withoutStyles = withoutScripts.replace(/<style[\s\S]*?<\/style>/gi, "");
    const text = withoutStyles.replace(/<[^>]+>/g, " ");
    return text.replace(/\s+/g, " ").trim();
  }
}

