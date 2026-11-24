// Types for e2e-shards.mjs, which playwright.config.ts imports.
export interface ShardMap {
  separate: string[];
  weights: Record<string, number>;
}
export interface Shard {
  files: string[];
  seconds: number;
}
export const MAP_FILE: string;
export function readMap(file?: string): ShardMap;
export function specFiles(dir: string): string[];
export function plan(files: string[], count: number, map: ShardMap): Shard[];
export function filesFor(value: string, dir: string, map?: ShardMap): string[];
