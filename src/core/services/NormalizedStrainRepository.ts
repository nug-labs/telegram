import axios from "axios";
import type { Strain, StrainMatch } from "../StrainTypes";
import type { StrainRepository } from "../ports/StrainRepository";

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[\s\-]+/g, "");
}

export class NormalizedStrainRepository implements StrainRepository {
  private readonly apiBaseUrl: string;
  private strains: Strain[] = [];
  private byKey: Map<string, Strain> = new Map();

  constructor(apiBaseUrl: string) {
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
  }

  async refresh(): Promise<void> {
    const url = `${this.apiBaseUrl}/api/v1/strains`;
    const response = await axios.get<Strain[]>(url, {
      timeout: 15000,
    });
    const list = response.data ?? [];

    this.strains = list;
    this.byKey = new Map();

    for (const strain of list) {
      if (!strain.name) continue;
      const nameKey = normalizeKey(strain.name);
      if (!this.byKey.has(nameKey)) {
        this.byKey.set(nameKey, strain);
      }

      const akas = strain.akas ?? [];
      for (const aka of akas) {
        if (!aka) continue;
        const akaKey = normalizeKey(aka);
        if (!this.byKey.has(akaKey)) {
          this.byKey.set(akaKey, strain);
        }
      }
    }
  }

  getAll(): Strain[] {
    return this.strains;
  }

  findByNameOrAka(query: string): StrainMatch | null {
    const key = normalizeKey(query);
    const strain = this.byKey.get(key);
    if (!strain) return null;

    if (normalizeKey(strain.name) === key) {
      return { strain, matchedBy: "name" };
    }

    const akas = strain.akas ?? [];
    if (akas.some((aka) => normalizeKey(aka) === key)) {
      return { strain, matchedBy: "aka" };
    }

    return { strain, matchedBy: "name" };
  }
}

