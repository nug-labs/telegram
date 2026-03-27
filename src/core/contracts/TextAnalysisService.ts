export interface TextAnalysisService {
  /**
   * Extract possible strain names from free-form text.
   *
   * This should return only names, without extra commentary.
   */
  extractStrainNames(text: string): Promise<string[]>;
}
