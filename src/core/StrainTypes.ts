export interface Strain {
  id?: number;
  name: string;
  type?: string;
  akas?: string[];
  [key: string]: unknown;
}

export interface StrainMatch {
  strain: Strain;
  matchedBy: "name" | "aka";
}

