# Media sites: checking the Now playing card by hand

The Now playing card (DESIGN.md §7.10) reads, plays and pauses most pages through their `<video>` and `<audio>` elements, and most players (YouTube's among them) follow their element. A few keep their own state or play from outside the page, so the card reads and presses the site's own button instead (`apps/desktop/src/main/media-sites.ts`). Their markup changes without notice, and E2E can't reach the real sites, so check them by hand before a release and whenever one is reported broken.

E2E covers the mechanism with a page that behaves like Twitch's player (`media.spec.ts`, *on Twitch, Play and Pause press its own button*), served at `www.twitch.tv` on this machine.

## For each site

1. Open the site in a chord and start something playing in its tab.
2. Switch to another tab: the card appears with the tab's title (and the track, when the site sets Media Session).
3. **Pause** on the card: the site's player shows paused, and the sound stops.
4. **Play** on the card: it plays again, and the site's own button agrees.
5. Switch to another chord and repeat 3 and 4.
6. Go back to the tab, pause it there, switch away: no card.

## Sites

| Site | Try | What the card presses | Notes |
|---|---|---|---|
| Twitch | A live channel | `button[data-a-target="player-play-pause-button"]`; state from `data-a-player-state` | Playing its `<video>` directly is undone by its player. |
| YouTube | A video, then a Short | Its `<video>` | Its player follows the element. A Short after a video leaves the video's player in the page, paused: the card must pause the Short. |
| YouTube Music | A playlist | Its `<video>` | The player bar follows the element. |
| SoundCloud | A track | `.playControls__play`; state from its `playing` class | It plays from an element outside the page, so only its button reaches it (and says whether it plays). |
| Bandcamp | An album page | `.inline_player .playbutton`; state from its `playing` class | |
| Anything else | Vimeo, a podcast page, a news video | The page's own `<video>` / `<audio>` | |

Sites that need DRM (Netflix, Spotify, Disney+, Prime Video) don't play in Chord yet (ARCHITECTURE.md §16, D4).

When a site's button changes, update its entry in `media-sites.ts` (prefer `data-*` hooks and ids over generated class names) and this table. Add a site only when its element doesn't work: a site's button is one more thing that breaks when it changes its markup.
