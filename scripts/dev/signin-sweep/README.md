# The sign-in sweep

How Chord's password detector does on real sign-in pages: the agent's scan, its classifier, what
focus on each field reports and the agent's own fill, on each site of a list. A tool for whoever
works on the detector, never run in CI (pages change daily). The S17 §13 canary is a narrower,
weekly cousin of it.

Everything it downloads or writes goes to a folder you name, **outside the repo**: the Tranco list,
the site list, each site's result and screenshot, and the report. The report names sites, and
nothing from it (names, addresses, markup) belongs in the repo. A fixture made from a finding
describes the pattern in Chord's own markup.

## Running it

```sh
# 1. The list: the top of the current Tranco list, with infrastructure, adult and gambling
#    sites taken out by name, and whatever else is in exclude.txt (one domain a line).
node scripts/dev/signin-sweep/list.mjs --out <dir> --top 2000 --count 420 --exclude <dir>/exclude.txt

# 2. The sweep, in the Linux E2E container (Xvfb), three sites at a time.
node scripts/dev/signin-sweep/sweep.mjs --dir <dir> --workers 3

# The report again, from the results as they are.
node scripts/dev/signin-sweep/report.mjs --dir <dir>
```

`<dir>/sites.txt` can be any file of URLs, one a line: a home page or a sign-in page. A site that
has a result already is skipped, so a run that stopped carries on where it was; delete
`<dir>/results` to start over. `sweep.mjs` passes other arguments to Playwright (`-g github` for
one site). It takes about 20 s a site.

## What it does on each site

In Electron (`apps/desktop/test/signin-sweep`): a window of its own with an in-memory session,
a normal Chrome user agent, no pop-ups, permissions or downloads. Chord's agent runs in isolated
world 4440, as it does in Chord, with a fake bridge that records what it would send main.

1. Loads the URL with no credentials. With no sign-in field on it, follows its *Sign in* /
   *Log in* link (or presses that button) once.
2. Waits for the form, then records the agent's scan, `classifyPasswordForm(…, 'filling')` and
   the probe's own look at the fields a person can see (by type and words, without the classifier).
3. Focuses each such field and records the agent's `focus`.
4. Fills as main would (`assist.ts`): `sweep.nobody@example.com` and a fake password, no
   password for a first step. Records the agent's `filled` and which fields hold the values.
5. On a first step (an email and Next), presses Next **once**, unless the page reads as sending a
   code or a link, then 2 to 4 on the step that follows.

Nothing is ever submitted beyond that one Next, and never on a page that would send a code or an
email. No account is signed in to or made.

## What counts as a problem

- a visible password field with no role; a username beside it not found; a first step not
  recognised;
- a hidden field with a role a visible one lacks;
- a sign-in page's form classed as something else (no menu);
- focus that reports nothing, or another role than the scan's;
- a fill refused, or values left out of the visible fields or written to hidden ones;
- `later:` patterns that belong to later phases (S17 §15): a sign-in in a frame, in an open
  shadow root, or on plain `http`.

A site that couldn't be swept says why: it didn't load, a bot wall or captcha, an HTTP error, or no
sign-in form found (only other sites' sign-in buttons, say). The probe's look is a guess too:
read a problem's screenshot before fixing the detector for it.
