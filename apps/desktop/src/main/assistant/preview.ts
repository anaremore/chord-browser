/**
 * Whether this build lets the assistant click and type (S18 M2e): every development build, and a packaged one once
 * ASSISTANT_ACTING_RELEASED, or a **preview** installer built with `CHORD_PREVIEW_ACTING=1` (the chord-preview skill),
 * so the owner can try it before the release turns it on. The release workflow never sets it
 * (assistant-preview.test.ts checks), so a release keeps acting off until the flag in core says otherwise.
 */
import { app } from 'electron';
import { ASSISTANT_ACTING_RELEASED, assistantActing } from '@chord/core';

declare const __CHORD_PREVIEW_ACTING__: boolean | undefined;

/** Set at build time from CHORD_PREVIEW_ACTING (electron.vite.config.ts): true only in a preview installer. */
const PREVIEW_ACTING: boolean = typeof __CHORD_PREVIEW_ACTING__ === 'boolean' && __CHORD_PREVIEW_ACTING__;

export const buildActs = (): boolean => assistantActing({ packaged: app.isPackaged }, ASSISTANT_ACTING_RELEASED || PREVIEW_ACTING);
