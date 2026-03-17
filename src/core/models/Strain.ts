export interface Strain {
  id?: number;
  name: string;
  type?: string;
  akas?: string[];
  [key: string]: unknown;
}
