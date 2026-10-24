/**
 * Play and Pause on sites whose player keeps its own state (DESIGN.md §7.10).
 * Playing their media element directly doesn't reach them (Twitch's player
 * pauses its video again; SoundCloud's isn't in the page), so the Now playing
 * card reads and presses the site's own button instead, from Chord's isolated
 * world, as a click in the page would. Everywhere else, and when a site's
 * button isn't on the page, the card reads, plays and pauses the page's own
 * media elements (media.ts). YouTube follows its video element, so it needs
 * nothing here.
 *
 * Sites change their markup: each entry names the button by its most stable
 * hook, and docs/testing/media-sites.md lists what to check by hand. Sites
 * that need DRM (Netflix, Spotify, Disney+…) don't play in Chord yet (D4).
 */

/**
 * A script fragment: `siteButton` (this site's play button, when the page is
 * one of these sites and the button is there, else null) and `sitePlays()`
 * (whether the button says the site's player plays).
 */
export const SITE_CONTROLS = `
  const SITES = [
    // Twitch: its player pauses its <video> again when it's played from outside; its button says its state.
    { hosts: ['twitch.tv'], button: 'button[data-a-target="player-play-pause-button"]', plays: (b) => b.getAttribute('data-a-player-state') === 'playing' },
    // SoundCloud plays from an element it keeps out of the page: only its button reaches it.
    { hosts: ['soundcloud.com'], button: '.playControls__play', plays: (b) => b.classList.contains('playing') },
    { hosts: ['bandcamp.com'], button: '.inline_player .playbutton', plays: (b) => b.classList.contains('playing') },
  ];
  const site = SITES.find((s) => s.hosts.some((h) => location.hostname === h || location.hostname.endsWith('.' + h)));
  const siteButton = site ? document.querySelector(site.button) : null;
  const sitePlays = () => site.plays(siteButton);
`;
