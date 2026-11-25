/**
 * The repo paths a Markdown text names, for the guards on AGENTS.md and the repo's skills: in code spans and link
 * targets, a word with a slash or a file extension. Commands, globs (`*`), placeholders (`<name>`), variables (`$X`),
 * Windows and WSL paths, and URLs aren't paths in the repo.
 */
export function namedPaths(text: string): string[] {
  const spans = [...text.matchAll(/`([^`\n]+)`/g), ...text.matchAll(/\]\(([^)\s#]+)(?:#[^)]*)?\)/g)].map((m) => m[1]!.trim());
  const paths = spans.filter((s) => /^[\w.@-]+(?:\/[\w.@-]+)*\/?$/.test(s) && (s.includes('/') || /\.(?:md|ts|tsx|mjs|js|json|yml|css)$/.test(s)));
  return [...new Set(paths)];
}
