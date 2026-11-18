/**
 * The passwords agent's channels (S17 §8): from world 4440 of a tab's main frame,
 * through the sentinel preload's bridge, to main. Web content's only IPC besides the
 * page preload's badge, so every message is checked here and again in main against
 * the sender's frame (`event.senderFrame.origin`, never a payload's word).
 *
 * **Field values, once.** A field is named by its type, id and name, never what it holds,
 * with two exceptions: a candidate sent at a submit signal carries the username and password
 * typed (`values`), so the save card can save them (S17 §6, step 1), and a first step's submit
 * (`step`) carries the username typed there, for the password step after it (S17 §4, phase 3).
 * Never at a blur, never in any other message. Every object is strict, so a payload carrying anything else (a
 * `value`, a `password`) is refused whole.
 */
import { PASSWORD_LIMITS, PASSWORDS_MAX_FORMS } from '@chord/core';
import { z } from 'zod';

/** The channels, by the agent's own name for each (the sentinel prefixes `passwords:`). */
export const PASSWORDS_AGENT_CHANNELS = ['focus', 'blur', 'forms', 'candidate', 'step', 'gone', 'still', 'hint', 'filled'] as const;
export type PasswordsAgentChannel = (typeof PASSWORDS_AGENT_CHANNELS)[number];
/** The preload asks main for the agent's script on this one (`invoke`). */
export const PASSWORDS_AGENT_SOURCE = 'passwords:agent';

/** The largest message main takes from a page: well over any real one (S17 §8, size limits). */
export const PASSWORDS_MESSAGE_MAX = 16 * 1024;

/** A per-document form id the agent gives: `f1`, `f2`… */
const formId = z.string().regex(/^f[0-9]{1,6}$/);
const kind = z.enum(['sign-in', 'sign-up', 'change', 'reset', 'username-only', 'unknown']);
const role = z.enum(['username', 'current-password', 'new-password', 'confirmation-password']);
/** A coordinate in the page's CSS pixels: finite and within any real page. */
const coordinate = z.number().finite().min(-1e6).max(1e6);
const size = z.number().finite().min(0).max(1e6);

/** A field, by what describes it: never its value. */
export const PasswordsFieldSignature = z.strictObject({
  type: z.string().max(20),
  id: z.string().max(80),
  name: z.string().max(80),
});
export type PasswordsFieldSignature = z.infer<typeof PasswordsFieldSignature>;

/** A sign-in field took focus: where it is, so the menu can sit under it. */
export const PasswordsFocus = z.strictObject({
  formId,
  kind,
  role,
  /** The field's box in the page's CSS pixels, from the top frame's viewport. */
  rect: z.strictObject({ x: coordinate, y: coordinate, width: size, height: size }),
  /**
   * A new password's field (`new-password`, `confirmation-password`): what it says of the passwords it takes, for the
   * generator (S17 §6). Its `passwordrules` attribute as written (cut to 2,000), and its `minlength` and `maxlength`
   * (-1 for none). Never its value.
   */
  rules: z
    .strictObject({
      passwordrules: z.string().max(2000),
      minLength: z.number().int().min(-1).max(1_000_000),
      maxLength: z.number().int().min(-1).max(1_000_000),
    })
    .optional(),
});
export type PasswordsFocus = z.infer<typeof PasswordsFocus>;

export const PasswordsBlur = z.strictObject({ formId });
export type PasswordsBlur = z.infer<typeof PasswordsBlur>;

/** The page's credential forms as they are now, for the reappeared-form check (S17 §6): structure only. */
export const PasswordsForms = z.strictObject({
  forms: z
    .array(
      z.strictObject({
        formId,
        kind,
        username: PasswordsFieldSignature.nullable(),
        password: PasswordsFieldSignature.nullable(),
        newPassword: PasswordsFieldSignature.nullable(),
      }),
    )
    // 20 forms of at most ~650 bytes each: well under PASSWORDS_MESSAGE_MAX (a test holds it).
    .max(PASSWORDS_MAX_FORMS),
});
export type PasswordsForms = z.infer<typeof PasswordsForms>;

/** A form you typed a password into, at a submit signal or as you left the field (S17 §6, step 1). */
export const PasswordsCandidate = z.strictObject({
  formId,
  kind,
  /** `submit` (the form's event), `enter` (in one of its fields), `button` (a click or key on a button in its scope), or `blur` (no submit yet). */
  signal: z.enum(['submit', 'enter', 'button', 'blur']),
  username: PasswordsFieldSignature.nullable(),
  password: PasswordsFieldSignature.nullable(),
  newPassword: PasswordsFieldSignature.nullable(),
  /** Whether those hold something. */
  hasUsername: z.boolean(),
  hasPassword: z.boolean(),
  /**
   * What was typed, at a submit signal only (never `blur`): the username, and the password to save (the new one
   * where the form has one). Within the vault's own limits; the agent leaves it out when a value isn't. Main holds
   * it in memory until the save card is answered, closed or goes, and never logs it.
   */
  values: z
    .strictObject({
      username: z.string().max(PASSWORD_LIMITS.username),
      password: z.string().min(1).max(PASSWORD_LIMITS.password),
      /** A change-password form's current password, beside its new one: how main finds the account it's for (S17 §6). */
      current: z.string().min(1).max(PASSWORD_LIMITS.password).optional(),
    })
    .optional(),
})
  // Values only at a submit signal: a candidate sent as you leave the field carries none.
  .refine((c) => c.signal !== 'blur' || c.values === undefined);
export type PasswordsCandidate = z.infer<typeof PasswordsCandidate>;

/**
 * A first step's submit (S17 §4, phase 3): a form the classifier reads as `username-only`, submitted with its username
 * (typed or not at your Enter or click; at a form's `submit` alone, only one typed or filled). Main keeps it for the tab and site a few minutes (Chromium's `possible_usernames_`), for a
 * password step that has no username field of its own. Never sent at a blur, nor for any other kind of form.
 */
export const PasswordsStep = z.strictObject({
  formId,
  signal: z.enum(['submit', 'enter', 'button']),
  username: z.string().min(1).max(PASSWORD_LIMITS.username),
});
export type PasswordsStep = z.infer<typeof PasswordsStep>;

/** After a submit signal: the password field went, or was hidden, within the agent's watch. */
export const PasswordsGone = z.strictObject({ formId });
/** After a submit signal: the form is still shown at the end of the watch. */
export const PasswordsStill = z.strictObject({ formId });

/** A request to the page's own origin finished after a submit signal (the PerformanceObserver; M0 Q7): a hint, never proof. */
export const PasswordsHint = z.strictObject({ formId, status: z.number().int().min(100).max(599) });
export type PasswordsHint = z.infer<typeof PasswordsHint>;

/**
 * A fill main sent: done (`ok`), or nothing written, and why: the form changed since the menu was shown (`changed`),
 * or it has a password field the fill had no password for (`password`: main sent none, or the field isn't the
 * current password), which would have filled half.
 */
export const PasswordsFilled = z.strictObject({ formId, ok: z.boolean(), reason: z.enum(['changed', 'password']).optional() });
export type PasswordsFilled = z.infer<typeof PasswordsFilled>;

/**
 * Main to the agent, the only way: fill the account you picked into the form the menu was shown for; or a generated
 * password (`generated`, S17 §6) into its new password's field and the confirmation's, and nothing else.
 */
export const PASSWORDS_FILL = 'passwords:fill';
export type PasswordsFill = {
  formId: string;
  /** The outline that shows where the values went (as the assistant's fill: no change to the page's DOM). */
  highlight: { color: string; ms: number; stagger: number; easing: string };
} & (
  | {
      username: string;
      /** Left out for a first step (`username-only`), which has no password field. */
      password?: string;
      /**
       * Picked in the menu of a new password's field (S17 §9): a form with no current password's field takes the
       * password in its new one and the confirmation. Anywhere else such a form gets nothing.
       */
      intoNew?: true;
      generated?: never;
    }
  | { generated: string; username?: never; password?: never; intoNew?: never }
);

export const passwordsAgentSchemas = {
  focus: PasswordsFocus,
  blur: PasswordsBlur,
  forms: PasswordsForms,
  candidate: PasswordsCandidate,
  step: PasswordsStep,
  gone: PasswordsGone,
  still: PasswordsStill,
  hint: PasswordsHint,
  filled: PasswordsFilled,
} as const satisfies Record<PasswordsAgentChannel, z.ZodType>;
export type PasswordsAgentMessage<C extends PasswordsAgentChannel> = z.infer<(typeof passwordsAgentSchemas)[C]>;
