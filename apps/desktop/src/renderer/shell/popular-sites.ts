/**
 * First run's "What do you open every day?" (DESIGN.md §8.1) completes from
 * this short built-in list: no network while you type.
 */
export const POPULAR_SITES = [
  'mail.google.com',
  'calendar.google.com',
  'docs.google.com',
  'drive.google.com',
  'youtube.com',
  'github.com',
  'notion.so',
  'figma.com',
  'app.slack.com',
  'linear.app',
  'outlook.office.com',
  'teams.microsoft.com',
  'chatgpt.com',
  'claude.ai',
  'x.com',
  'reddit.com',
  'news.ycombinator.com',
  'wikipedia.org',
  'open.spotify.com',
  'netflix.com',
  'amazon.com',
  'maps.google.com',
  'web.whatsapp.com',
  'discord.com/app',
  'trello.com',
  'dropbox.com',
  'icloud.com',
  'feedly.com',
] as const;

/** Popular sites that start with (or contain) what you've typed, best first. */
export function suggestSites(text: string, limit = 4): string[] {
  const query = text.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '');
  if (!query) return [];
  const starts = POPULAR_SITES.filter((site) => site.startsWith(query) || site.split('.').some((part) => part.startsWith(query)));
  const contains = POPULAR_SITES.filter((site) => !starts.includes(site) && site.includes(query));
  return [...starts, ...contains].slice(0, limit);
}

/** What you typed as an address Chord can open: a scheme is added when there isn't one. */
export function asUrl(text: string): string | null {
  const value = text.trim();
  if (!value || /\s/.test(value)) return null;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const parsed = new URL(url);
    // A web address with a real-looking host: a dot (names and IPs), or localhost.
    const host = parsed.hostname;
    return /^https?:$/.test(parsed.protocol) && (host.includes('.') || host === 'localhost') ? parsed.href : null;
  } catch {
    return null;
  }
}
