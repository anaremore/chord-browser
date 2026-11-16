/**
 * The passwords agent's channels (S17 §8): from world 4440 of a tab's main frame,
 * through the sentinel preload's bridge, to main. Web content's only IPC besides the
 * page preload's badge, so every message is checked here and again in main against
 * the sender's frame (`event.senderFrame.origin`, never a payload's word).
 *
 * **No field values.** A field is named by its type, id and name, never what it holds.
 * Every object is strict, so a payload carrying anything else (a `value`, a `password`)
 * is refused whole. The save card's phase adds one optional `values` field to
 * `PasswordsCandidate`, under its own review.
 */
import { z } from 'zod';

/** The channels, by the agent's own name for each (the sentinel prefixes `passwords:`). */
export const PASSWORDS_AGENT_CHANNELS = ['focus', 'blur', 'forms', 'candidate', 'gone', 'still', 'hint'] as const;
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
    .max(50),
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
  /** Whether those hold something: what saving needs to know before it asks for a value. */
  hasUsername: z.boolean(),
  hasPassword: z.boolean(),
});
export type PasswordsCandidate = z.infer<typeof PasswordsCandidate>;

/** After a submit signal: the password field went, or was hidden, within the agent's watch. */
export const PasswordsGone = z.strictObject({ formId });
/** After a submit signal: the form is still shown at the end of the watch. */
export const PasswordsStill = z.strictObject({ formId });

/** A request to the page's own origin finished after a submit signal (the PerformanceObserver; M0 Q7): a hint, never proof. */
export const PasswordsHint = z.strictObject({ formId, status: z.number().int().min(100).max(599) });
export type PasswordsHint = z.infer<typeof PasswordsHint>;

export const passwordsAgentSchemas = {
  focus: PasswordsFocus,
  blur: PasswordsBlur,
  forms: PasswordsForms,
  candidate: PasswordsCandidate,
  gone: PasswordsGone,
  still: PasswordsStill,
  hint: PasswordsHint,
} as const satisfies Record<PasswordsAgentChannel, z.ZodType>;
export type PasswordsAgentMessage<C extends PasswordsAgentChannel> = z.infer<(typeof passwordsAgentSchemas)[C]>;
