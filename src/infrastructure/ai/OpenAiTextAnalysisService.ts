import type { TextAnalysisService } from "../../core/contracts/TextAnalysisService";

interface ChatCompletionResponse {
  choices: { message?: { content?: string } }[];
}

/**
 * OpenAI-backed implementation of TextAnalysisService.
 */
export class OpenAiTextAnalysisService implements TextAnalysisService {
  private readonly apiKey: string;
  private readonly model: string;

  constructor(apiKey: string, model = "gpt-4.1-mini") {
    if (!apiKey) {
      throw new Error("API key is required for OpenAiTextAnalysisService");
    }
    this.apiKey = apiKey;
    this.model = model;
  }

  async extractKnownNames(text: string, knownNames: string[]): Promise<string[]> {
    if (!text.trim() || knownNames.length === 0) {
      return [];
    }

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
      throw new Error(`OpenAI error: ${res.status} ${body}`);
    }

    const data = (await res.json()) as ChatCompletionResponse;
    const content = data.choices?.[0]?.message?.content ?? "[]";

    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed.filter((x) => typeof x === "string") as string[];
      }
    } catch {
      // fall through
    }

    return [];
  }
}
