export interface TextAnalysisService {
  /**
   * Given free-form text and a list of known strain names,
   * return the subset of names that are mentioned in the text.
   */
  extractKnownNames(text: string, knownNames: string[]): Promise<string[]>;
}

