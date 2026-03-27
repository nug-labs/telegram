import type { TextAnalysisService } from "../../core/contracts/TextAnalysisService";
import type { AppAnalytics } from "../analytics/AppAnalytics";

interface ChatCompletionResponse {
  choices: { message?: { content?: string } }[];
}

/**
 * OpenAI-backed implementation of TextAnalysisService.
 */
export class OpenAiTextAnalysisService implements TextAnalysisService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly analytics?: AppAnalytics;

  constructor(apiKey: string, model = "gpt-4.1-mini", analytics?: AppAnalytics) {
    if (!apiKey) {
      throw new Error("API key is required for OpenAiTextAnalysisService");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.analytics = analytics?.child({ component: "openai_text_analysis" });
  }

  async extractStrainNames(text: string): Promise<string[]> {
    // This service requires known names to constrain extraction. It is no longer used by the Telegram bot,
    // but we keep it for compatibility with the old interface via an empty result.
    return this.extractKnownNames(text, []);
  }

  async extractKnownNames(text: string, knownNames: string[]): Promise<string[]> {
    if (!text.trim() || knownNames.length === 0) {
      return [];
    }
    const startedAt = Date.now();
    this.analytics?.info("openai_extract_start", {
      props: { textLength: text.length, knownNamesCount: knownNames.length },
    });

    const endpoint = "https://api.openai.com/v1/chat/completions";
    const systemPrompt =
      "You are a helper that extracts cannabis strain names from text. " +
      "You will be given user-provided text and a list of known strain names. " +
      "Return ONLY the subset of known names that appear in the text, in a JSON array of strings.";

    const userPrompt = JSON.stringify({
      text,
      knownNames,
    });

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 512,
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      this.analytics?.error("openai_extract_failed", {
        props: {
          status: res.status,
          durationMs: Date.now() - startedAt,
          bodyPreview: body.slice(0, 500),
        },
      });
      throw new Error(`OpenAI error: ${res.status} ${body}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content ?? "[]";

    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        const output = parsed.filter((x) => typeof x === "string") as string[];
        this.analytics?.info("openai_extract_success", {
          props: {
            durationMs: Date.now() - startedAt,
            extractedCount: output.length,
          },
        });
        return output;
      }
    } catch {
      // fall through
    }

    this.analytics?.warn("openai_extract_success", {
      props: {
        durationMs: Date.now() - startedAt,
        extractedCount: 0,
        parserFallback: true,
      },
    });
    return [];
  }
}
