/**
 * A tab of yours copying (its copy or cut event, in its top frame): main puts the clipboard back only if the assistant's
 * click set it off (control/user-watch.ts' userTabCopied; Claude's B2, round 2 of #150). Trusted events only: a page's
 * own `new ClipboardEvent('copy')` writes nothing, and would mark your copy as the page's (the final check of #150).
 * Your own copy ends any lease first (your key), so it's never put back.
 */
type CopyWindow = { addEventListener(type: string, listener: (event: { isTrusted: boolean }) => void, capture: boolean): void };

export function installCopyReport(win: CopyWindow, report: () => void): void {
  for (const type of ['copy', 'cut']) win.addEventListener(type, (event) => void (event.isTrusted && report()), true);
}
