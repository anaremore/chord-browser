/**
 * Reader view's cleaning on pages built to be slow (reader.test.ts checks what it keeps): a tree that refers to itself
 * (structured clone can send one), and a page of 100,000 paragraphs. Each is held to 2 s, far over what it takes, so a
 * walk that stops being bounded fails. Moved from reader.test.ts (issue #85): budgets run alone, in `pnpm test:perf`.
 */
import { describe, expect, it } from 'vitest';
import { sanitizeArticle, type RawNode } from '../src';

// Core compiles without DOM or Node types; both are globals where the tests run.
declare const performance: { now(): number };
declare const console: { log(...args: unknown[]): void };

const PAGE = 'https://news.example/2026/10/story?id=7';
const LONG = 'Readers came for the story and stayed for the details, which the page told at length and with care. '.repeat(4);
const el = (tag: string, attrs: Record<string, string> = {}, ...children: RawNode[]): RawNode => ({ tag, attrs, children });
const p = (...children: RawNode[]) => el('p', {}, ...children);
const BUDGET_MS = 2000;

describe('reader view on pages built to be slow', () => {
  it(`a tree that refers to itself: cleaned in under ${BUDGET_MS} ms`, () => {
    const loop: { tag: string; children: unknown[] } = { tag: 'div', children: ['loop '] };
    loop.children.push(loop, loop);
    const started = performance.now();
    expect(sanitizeArticle({ title: 'x', content: el('div', {}, p(LONG), loop as unknown as RawNode) }, PAGE)).not.toBeNull();
    const ms = performance.now() - started;
    console.log(`a looped tree: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it(`100,000 paragraphs: cleaned in under ${BUDGET_MS} ms`, () => {
    const huge = el('div', {}, ...Array.from({ length: 100_000 }, (_, i) => p(`Paragraph ${i} `, el('em', {}, 'with emphasis'))));
    const started = performance.now();
    expect(sanitizeArticle({ title: 'x', content: huge }, PAGE)).not.toBeNull();
    const ms = performance.now() - started;
    console.log(`100,000 paragraphs: ${ms.toFixed(1)} ms`);
    expect(ms).toBeLessThan(BUDGET_MS);
  });
});
