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


**Added after Neon's design review (2026-11-24):**
- *A name from `aria-label` that says something else than the element shows* (B3): name targeting refuses any element whose name isn't its visible text, a visible label's or a button's value. Exact, non-empty, allowlisted roles (generic included).
- *A name-resolved target overwriting the agent's refs* (B4): it lives in its own slot. The step key is a JSON tuple binding its items, place, visible text and shape, so a late Allow never covers a lookalike.
- *A step card answered twice* (B1): a retry joins the step's card; another action spends the tab's late Allows.
- *A Send data card dropped by a call's budget* (B2): never; it keeps its full wait.
- *`wait_for` left running after the client gave up* (B5): the client's cancel, Stop, the tab taken or a navigation end it and take its observer down; one wait per agent.
- *A cut walk read as "gone"* (B5): it never proves `disappear`.
- *A diff that mixes two pages* (B6): never across page IDs or origins; only the redacted outline.

**Added with the last of slice (b) (2026-11-24):**
- *`wait_for` across a `pushState`:* the same document keeps waiting, under the same readability check between chunks (`blockedNow`: a never-read address ends it). Its refs are stale, the result says so, and its outline is whole, never a diff across page IDs.
- *The bar while it waits:* Chord's words only (*is waiting on this page*), never the agent's text.

**Added after Neon's round 1 on the code (2026-11-25):**
- *A name a page gives an element for what it doesn't show* (B-1): found by name only when the name is its own shown words, a shown label, or a button's value. Never `aria-label`, `aria-labelledby`, `title`, `aria-placeholder`, alt text, a hidden label, or words hidden by `visibility` or `opacity`. *Tests:* control.test, by role and name; core control-snapshot.test (`seen`); agents.spec, each kind on `/aria` and an editable body.
- *A late Allow on a moved or renamed element* (B-2): the step key and the step's checks carry its name, its items and its place. *Test:* control.test, *a step's key and its checks name the element*.
- *A read by name from a page that went elsewhere or may not be read* (B-2): refused. *Test:* control.test, by role and name.
- *`wait_for` as an oracle on typed text* (B-3): a page that is an editor (an editable body, or `designMode`) is never looked at for text. *Tests:* control.test; agents.spec on `/aria-body` and `/design`.
- *`wait_for` for the assistant, and the agent's words on a card* (B-4): outside agents only; the card and the activity in Chord's words. *Tests:* core control-snapshot.test; control.test.
- *A diff across a never-read site, another origin, or a cut read* (B-6): none, or a note to call snapshot. *Test:* control.test.
- *A batch running on after the user took the tab* (B-7): checked before each step. *Tests:* control.test, *batch*.

