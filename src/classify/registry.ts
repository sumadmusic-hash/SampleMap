import type { Classifier } from "./classifier";

/**
 * Registry of available Classifier implementations keyed by model id.
 *
 * The analysis pipeline asks the registry for a classifier by id; this is what
 * makes the model exchangeable (SAMPLEMAP_V1_SPEC §7.2): registering a new
 * model (e.g. a small CNN) is a drop-in addition and results can be re-run via
 * the id/version.
 */
export class ClassifierRegistry {
  private readonly map = new Map<string, Classifier>();

  register(c: Classifier): this {
    if (this.map.has(c.id)) {
      throw new Error(`classifier already registered: ${c.id}`);
    }
    this.map.set(c.id, c);
    return this;
  }

  get(id: string): Classifier | undefined {
    return this.map.get(id);
  }

  has(id: string): boolean {
    return this.map.has(id);
  }

  list(): string[] {
    return Array.from(this.map.keys());
  }
}
