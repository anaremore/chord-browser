/**
 * Settings → Agents (S18 M1d; mocks/agents-s18-m1.html §4): what it shows.
 * The setup lines come from this Chord's own executable (never a guess: S18
 * §2), and the lists from the agents connected now and those allowed for good.
 */
import { sortedChords, type AgentAllowance, type ChordId, type State } from '@chord/core';
import type { AgentsView } from '@chord/ipc';

export interface SetupWhere {
  platform: NodeJS.Platform;
  packaged: boolean;
  /** `app.getPath('exe')`. */
  exe: string;
  /** The app's folder (development builds run `electron <folder>`). */
  appPath: string;
  /** `$APPIMAGE`: where an AppImage is now (it moves with its file). */
  appImage?: string | undefined;
  /** Inside a Flatpak: its id (`$FLATPAK_ID`), which `flatpak run` takes. */
  flatpak: string | null;
}

/** A path as a terminal takes it: in quotes when it has a space or a character a shell reads. */
const quote = (path: string) => (/[\s"'$`&()]/.test(path) ? `"${path.replace(/"/g, '\\"')}"` : path);

/** The command that runs `chord mcp` here, as a terminal takes it. */
export function mcpCommand(where: SetupWhere): string {
  if (where.flatpak) return `flatpak run ${where.flatpak} mcp`;
  const exe = where.platform === 'linux' && where.appImage ? where.appImage : where.exe;
  const program = where.packaged ? quote(exe) : `${quote(exe)} ${quote(where.appPath)}`;
  // Linux: with no display (SSH, a headless box) Electron stops before any of Chord runs, unless told so on argv (S18 §2).
  return where.platform === 'linux' ? `${program} --ozone-platform=headless mcp` : `${program} mcp`;
}

/** The lines to paste: Claude Code's and Codex's own ways to add an MCP server. */
export function setupLines(where: SetupWhere): AgentsView['setup'] {
  const command = mcpCommand(where);
  return { claude: `claude mcp add chord -- ${command}`, codex: `codex mcp add chord -- ${command}` };
}

/** Whose sign-ins an allowance uses, as the row says it: the one chord using them, or that they're shared. */
export function signInsName(state: State, profileId: string): string {
  const chords = sortedChords(state).filter((c) => c.profileId === profileId);
  if (chords.length === 0) return '';
  return chords.length === 1 ? `${chords[0]!.name}’s sign-ins` : 'Shared sign-ins';
}

/** A connected agent, as Settings needs it. */
export interface ConnectedAgent {
  id: string;
  name: string;
  always: boolean;
  stopped: boolean;
  chordId: ChordId | null;
}

export function agentsView(state: State, connected: readonly ConnectedAgent[], setup: AgentsView['setup']): AgentsView {
  const tabsOf = (chordId: ChordId | null) => (chordId ? Object.values(state.nodes).reduce((n, bucket) => n + Object.values(bucket ?? {}).filter((node) => node.kind === 'tab' && node.chordId === chordId).length, 0) : 0);
  const allowed = state.settings.agentsAllowed.map((a: AgentAllowance) => {
    const live = connected.find((c) => c.always && c.name === a.name);
    return { name: a.name, parent: a.parent, signIns: signInsName(state, a.profileId), connected: Boolean(live), tabs: tabsOf(live?.chordId ?? null), lastUsedAt: a.lastUsedAt };
  });
  return {
    setup,
    stopped: connected.filter((c) => c.stopped).map((c) => ({ id: c.id, name: c.name, tabs: tabsOf(c.chordId) })),
    allowed,
  };
}
