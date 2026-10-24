/**
 * Settings → General → Links: where links from other apps open (a mini
 * window, or a new tab), and link routes (from Crest) that send a site's links
 * to a chord, from other apps and from the command bar.
 */
import { DEFAULT_SETTINGS, routeKey, type ExternalLinks } from "@chord/core";
import type { SettingsSnapshot } from "@chord/ipc";
import { X } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "./api";
import { Row, Segmented } from "./controls";
import local from "./Links.module.css";
import styles from "./Settings.module.css";
import sites from "./Sites.module.css";

const OPEN_IN: { value: ExternalLinks; label: string }[] = [
  { value: "mini", label: "Mini window" },
  { value: "tab", label: "New tab" },
];

export function Links({ snapshot }: { snapshot: SettingsSnapshot }) {
  const { settings, chords, linkRoutes } = snapshot;
  const [site, setSite] = useState("");
  const [chordId, setChordId] = useState(chords[0]?.id ?? "");
  const host = routeKey(site);
  const target = chords.some((c) => c.id === chordId)
    ? chordId
    : (chords[0]?.id ?? "");

  const add = (event: FormEvent) => {
    event.preventDefault();
    if (!host || !target) return;
    void api.settings.linkRoute(host, target);
    setSite("");
  };

  return (
    <>
      <h2 className={styles.groupTitle}>Links</h2>
      <div className={styles.group}>
        <Row
          label="Links from other apps open in"
          description="A mini window is quick to read and close; Open in moves the page into a chord. A site with a route below always goes to its chord."
          changed={settings.externalLinks !== DEFAULT_SETTINGS.externalLinks}
          onReset={() =>
            void api.settings.set({
              externalLinks: DEFAULT_SETTINGS.externalLinks,
            })
          }
          control={
            <Segmented<ExternalLinks>
              label="Links from other apps open in"
              value={settings.externalLinks}
              options={OPEN_IN}
              onChange={(externalLinks) =>
                void api.settings.set({ externalLinks })
              }
            />
          }
        />
      </div>

      <h2 className={styles.groupTitle}>Link routes</h2>
      <div className={styles.group}>
        {linkRoutes.length === 0 && (
          <p className={local.empty}>
            No routes yet. When you keep moving a site’s pages to one chord,
            Chord offers to send its links there.
          </p>
        )}
        {linkRoutes.map((route) => (
          <Row
            key={route.host}
            label={route.host}
            control={
              <span className={local.controls}>
                <select
                  className={sites.select}
                  aria-label={`Chord for ${route.host}`}
                  value={route.chordId}
                  onChange={(e) =>
                    void api.settings.linkRoute(route.host, e.target.value)
                  }
                >
                  {chords.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.icon} {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className={local.remove}
                  aria-label={`Remove the route for ${route.host}`}
                  onClick={() => void api.settings.linkRoute(route.host, null)}
                >
                  <X size={14} strokeWidth={2} aria-hidden />
                </button>
              </span>
            }
          />
        ))}
        <form className={local.add} onSubmit={add}>
          <input
            className={local.input}
            value={site}
            placeholder="github.com or github.com/acme"
            aria-label="Site for a new route"
            spellCheck={false}
            autoComplete="off"
            onChange={(e) => setSite(e.target.value)}
          />
          <select
            className={sites.select}
            aria-label="Chord for the new route"
            value={target}
            onChange={(e) => setChordId(e.target.value)}
          >
            {chords.map((c) => (
              <option key={c.id} value={c.id}>
                {c.icon} {c.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            className={styles.linkButton}
            disabled={!host || !target}
          >
            Add route
          </button>
        </form>
      </div>
      <p className={styles.groupNote}>
        A route covers the site’s subdomains too: github.com includes
        gist.github.com.
      </p>
    </>
  );
}
