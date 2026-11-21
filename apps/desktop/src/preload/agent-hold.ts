/**
 * An outside agent's tab (S18; main/tabs.ts gives its pages AGENT_TAB_ARG): page dialogs and file pickers are
 * held, in the page's own world, so the agent's reads never wait on one and nothing opens a native window.
 * alert answers at once, confirm "Cancel", prompt nothing; a file picker opens nothing. What was held goes to
 * main for the agent's next result. Electron's `disableDialogs` backs it up in frames this doesn't reach.
 */
export function holdForAgent(held: (kind: 'dialog' | 'file', detail: string) => void): void {
  const page = globalThis as unknown as Record<string, unknown> & { HTMLInputElement?: { prototype: object }; DOMException: new (m: string, n: string) => unknown };
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
}

