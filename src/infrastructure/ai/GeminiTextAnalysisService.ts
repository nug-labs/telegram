import type { TextAnalysisService } from "../../core/contracts/TextAnalysisService";
import type { AppAnalytics } from "../analytics/AppAnalytics";

interface GeminiGenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

export class GeminiRateLimitError extends Error {
  readonly retryAfterSeconds?: number;

  constructor(message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "GeminiRateLimitError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function stripJsonCodeFence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed.startsWith("```")) return trimmed;
  // Handles ```json ... ``` or ``` ... ```
  const firstNewline = trimmed.indexOf("\n");
  if (firstNewline === -1) return trimmed;
  const withoutFirstLine = trimmed.slice(firstNewline + 1);
  const endFence = withoutFirstLine.lastIndexOf("```");
  if (endFence === -1) return withoutFirstLine.trim();
  return withoutFirstLine.slice(0, endFence).trim();
}

function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

function truncate(value: string, max = 800): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… (truncated, ${value.length} chars)`;
}

function normalizePasteText(raw: string): string {
  return raw
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    // Drop obvious pricing/quantity blobs that bloat tokens.
    .replace(/\b\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?\b/g, " ")
    .replace(/\b(?:topmids|top mids|pound|hp)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Gemini-backed implementation of TextAnalysisService.
 *
 * Prompts Gemini with ONLY the paste content and asks for strain names only.
 */
export class GeminiTextAnalysisService implements TextAnalysisService {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly analytics?: AppAnalytics;

  constructor(apiKey: string, model = "gemini-1.5-flash", analytics?: AppAnalytics) {
    if (!apiKey) {
      throw new Error("API key is required for GeminiTextAnalysisService");
    }
    this.apiKey = apiKey;
    this.model = model;
    this.analytics = analytics?.child({ component: "gemini_text_analysis" });
  }

  async extractStrainNames(text: string): Promise<string[]> {
    const cleanedText = normalizePasteText(text);
    if (!cleanedText.trim()) return [];

    const startedAt = Date.now();
    this.analytics?.info("gemini_extract_start", {
      props: { textLength: text.length },
    });

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.apiKey}`;

    const system =
      "You extract cannabis strain NAMES from raw text (menus, lists, promos). " +
      "Return ONLY a JSON array of strings (strain names). No markdown, no commentary, no extra keys. " +
      "Only include names explicitly present in the text.\n\n" +
      "Normalization rules:\n" +
      "- Ignore emojis and decorative symbols.\n" +
      "- Treat 'BlueDream' and 'Blue Dream' as the same; return the best spaced form (e.g. 'Blue Dream').\n" +
      "- Keep original capitalization when obvious; otherwise Title Case.\n" +
      "- Remove quantity/price/weight/unit text (e.g. '3.5-25', 'TopMids', flags).\n" +
      "- Do NOT invent strain names.\n\n" +
      "Output format: JSON array of unique strings, e.g. [\"Blue Dream\", \"Mimosa\"].";

    // Keep the input bounded so the model has room to respond fully.
    const boundedText = cleanedText.length > 12000 ? cleanedText.slice(0, 12000) : cleanedText;
    const modelInput = `${system}\n\nTEXT:\n${boundedText}`;
    // eslint-disable-next-line no-console
    console.log("[gemini] model:", this.model);
    // eslint-disable-next-line no-console
    console.log("[gemini] input:", truncate(modelInput, 2000));

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: modelInput }] }],
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 1024,
          responseMimeType: "application/json",
        },
      }),
    });

    if (!res.ok) {
      const body = await res.text();
      if (res.status === 429) {
        let retryAfterSeconds: number | undefined;
        try {
          const parsed = JSON.parse(body) as any;
          const details = parsed?.error?.details as any[] | undefined;
          const retryInfo = details?.find((d) => d?.["@type"]?.includes("RetryInfo"));
          const retryDelay = retryInfo?.retryDelay as string | undefined; // e.g. "26s"
          const match = typeof retryDelay === "string" ? retryDelay.match(/(\d+)s/) : null;
          if (match) retryAfterSeconds = Number(match[1]);
        } catch {
          // ignore parse errors
        }

        this.analytics?.warn("gemini_extract_failed", {
          props: {
            status: res.status,
            durationMs: Date.now() - startedAt,
            retryAfterSeconds,
            bodyPreview: body.slice(0, 500),
          },
        });

        throw new GeminiRateLimitError(
          `Gemini rate limit exceeded for model ${this.model}.`,
          retryAfterSeconds
        );
      }

      this.analytics?.error("gemini_extract_failed", {
        props: {
          status: res.status,
          durationMs: Date.now() - startedAt,
          bodyPreview: body.slice(0, 500),
        },
      });
      throw new Error(`Gemini error: ${res.status} ${body}`);
    }

    const data = (await res.json()) as GeminiGenerateContentResponse;
    const content =
      data.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("\n") ?? "[]";

    // eslint-disable-next-line no-console
    console.log("[gemini] raw output:", truncate(content, 2000));

    const tryParse = (raw: string): string[] | null => {
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return null;
        return parsed.filter((x) => typeof x === "string").map(normalizeName).filter(Boolean);
      } catch {
        return null;
      }
    };

    const unfenced = stripJsonCodeFence(content);
    const parsed =
      tryParse(unfenced) ??
      (extractFirstJsonArray(unfenced) ? tryParse(extractFirstJsonArray(unfenced)!) : null);

    const output = Array.from(new Set((parsed ?? []).map(normalizeName).filter(Boolean))).slice(0, 50);

    // eslint-disable-next-line no-console
    console.log("[gemini] parsed names:", output);

    this.analytics?.info("gemini_extract_success", {
      props: { durationMs: Date.now() - startedAt, extractedCount: output.length },
    });

    return output;
  }
}

