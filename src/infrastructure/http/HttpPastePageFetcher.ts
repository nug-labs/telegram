export interface PasteContentService {
  /**
   * If the incoming text contains a supported paste link, returns its URL;
   * otherwise returns null.
   */
  extractUrlFromText(text: string): string | null;

  /**
   * Given a paste URL, fetch its textual contents.
   */
  fetchText(url: string): Promise<string>;
}

