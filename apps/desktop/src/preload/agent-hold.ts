/**
 * An outside agent's tab (S18; main/tabs.ts gives its pages AGENT_TAB_ARG): page dialogs and file pickers are
 * held, in the page's own world, so the agent's reads never wait on one and nothing opens a native window.
 * alert answers at once, confirm "Cancel", prompt nothing; a file picker opens nothing. What was held goes to
 * main for the agent's next result. Electron's `disableDialogs` backs it up in frames this doesn't reach.
 */
export function holdForAgent(held: (kind: 'dialog' | 'file', detail: string) => void): void {
  const page = globalThis as unknown as Record<string, unknown> & { HTMLInputElement?: { prototype: object }; DOMException: new (m: string, n: string) => unknown };
  // No shared workers, deferred sends or service workers (#112 reviews 3 and 4: what they send goes out of the hold's
  // sight). The hold's new-document script removes them in every frame it reaches (agents/agent-scripts.ts'
  // PAGE_LACKS), and each document's policy leaves deferred sends no quota anywhere (control/sends.ts' AGENT_POLICY);
  // this is the same, where this preload runs first.
  for (const name of ['SharedWorker', 'fetchLater']) {
    try {
      delete page[name];
    } catch {
      // Not configurable here: the hold's script has the last word.
    }
  }
  try {
    delete (page['Navigator'] as { prototype: Record<string, unknown> } | undefined)?.prototype['serviceWorker'];
  } catch {
    // As above.
  }
  const answers: Record<string, unknown> = { alert: undefined, confirm: false, prompt: null };
  for (const name of Object.keys(answers)) {
    const original = page[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(page, name, {
      value: new Proxy(original as (...args: unknown[]) => unknown, {
        apply: (_target, _self, args) => {
          held('dialog', `${name}: ${String(args[0] ?? '')}`);
          return answers[name];
        },
      }),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  for (const name of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    const original = page[name];
    if (typeof original !== 'function') continue;
    Object.defineProperty(page, name, {
      value: new Proxy(original as (...args: unknown[]) => unknown, {
        apply: () => {
          held('file', name);
          return Promise.reject(new page.DOMException('The user aborted a request.', 'AbortError'));
        },
      }),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  const input = page.HTMLInputElement?.prototype as { showPicker?: (...args: unknown[]) => unknown } | undefined;
  const showPicker = input?.showPicker;
  if (input && typeof showPicker === 'function') {
    Object.defineProperty(input, 'showPicker', {
      value: new Proxy(showPicker, {
        apply: (target, self, args) => {
          if ((self as { type?: string }).type !== 'file') return Reflect.apply(target, self, args);
          held('file', 'showPicker');
          return undefined;
        },
      }),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  }
  // Passkeys, sign-in and payment dialogs: refused in an agent's tab by its policy (control/sends.ts' AGENT_POLICY:
  // Chord doesn't sign agents in), and said in the agent's next result, as a held dialog is (the final pass of #112).
  const report = (owner: object | undefined, name: string, what: string) => {
    const original = (owner as Record<string, unknown> | undefined)?.[name];
    if (!owner || typeof original !== 'function') return;
    Object.defineProperty(owner, name, {
      value: new Proxy(original as (...args: unknown[]) => unknown, {
        apply: (target, self, args) => {
          held('dialog', what);
          return Reflect.apply(target, self, args);
        },
      }),
      writable: true,
      enumerable: false,
      configurable: true,
    });
  };
  const credentials = (page['CredentialsContainer'] as { prototype?: object } | undefined)?.prototype;
  report(credentials, 'get', 'a passkey or sign-in dialog (refused: Chord doesn’t sign agents in)');
  report(credentials, 'create', 'a passkey dialog (refused: Chord doesn’t sign agents in)');
  report((page['PaymentRequest'] as { prototype?: object } | undefined)?.prototype, 'show', 'a payment dialog (refused)');
}

