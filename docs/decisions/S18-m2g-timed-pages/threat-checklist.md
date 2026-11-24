# S18 M2g-1: threat checklist

For the plan in `plan.md`. Written before the design review; each item gets a test (the table in `plan.md`).

- *Name-based targeting:*
  - **Duplicates:** two elements with that role and name means a refusal, never a guess; the result says to add `within` or use a ref. A page can add a twin to make the agent's step refuse. That only stops the agent, as covering an element does.
  - **Items:** `within` is checked as the item chain is (named rows, list items, articles, dialogs, tab panels, regions). Unnamed items can't be named, so the agent uses a ref there.
  - **Swaps between resolving and the press:** once resolved, the element is held like a ref's. A replacement after that is handled by #117's rules (found again only at safe points, unique, the same items and shape), and the press starts over from the pointer's move at most 3 times.
  - **A name the page chooses to mislead:** the agent asked for "Raise: 5" and gets an element the page named that. It's no new power: with refs, the agent read the same name from the snapshot. The step is classified from the element (its form, link, fields), never from the name the agent asked for, and a risky step's card shows the page's element.
  - **Hidden or off-screen elements, frames, closed shadow roots:** they don't count (the snapshot's rules), aren't looked in (M2g's later slices), and are refused by the closed-root check.
  - **Fields that are sensitive:** never matched for `type` (password, one-time code, card), as with refs. They have no ref in the snapshot either.
  - **Cost:** the resolving walk uses the snapshot's budget (20,000 elements, 50 ms), and refuses past it.
- *`wait_for` as a side channel:* it only tells the agent what a snapshot would (text or an element in the page the agent may already read). It needs the tab to be one the agent may read (the same rules as `read_tab`). It never sees frames' contents or closed roots, and the never-read sites are refused as for `snapshot`.
- *`wait_for` as a DoS:*
  - At most 30 s, one wait at a time for each agent tab (a second refuses). Stop, the user taking the tab, the tab closing or navigating ends it at once.
  - Its checks run on mutations, throttled (at most one check per animation frame, each bounded like the resolving walk), in Chord's isolated world, so the page can't see or slow it more than a snapshot does.
  - A page that mutates all the time costs at most one bounded check a frame for up to 30 s.
- *The snapshot after an action:*
  - **Size:** the same caps as `snapshot` (refs, characters, elements, time), smaller by default (a compact form), and the result says when it was cut.
  - **Trust:** it's marked untrusted page content, as `snapshot` is, so its text can't pass as Chord's words.
  - **Refs:** it replaces the tab's latest snapshot (its refs are the current ones). Taken only after the action settled, on the same page: a page that navigated gives none, and the result says it navigated.
  - **Cost:** only when asked for; measured, and inside the snapshot budget.
- *#143, answering before the card does:*
  - The answer says to try again, and nothing has run. A retry while the card is up waits on the same card; it never opens a second one.
  - The late Allow is kept for the exact step (tab, page, ref or target, action, text) and used once. A changed step asks again.
  - Stop, the user denying, or the card expiring drop it.
  - With progress notifications, the call stays open only while the card is up, never past the card's own limit.

