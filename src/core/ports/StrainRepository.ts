import type { Strain, StrainMatch } from "../StrainTypes";

export interface StrainRepository {
  refresh(): Promise<void>;
  getAll(): Strain[];
  findByNameOrAka(query: string): StrainMatch | null;
}

