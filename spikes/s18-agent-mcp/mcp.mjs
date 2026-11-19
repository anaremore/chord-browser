// Spike S18 M0: the bridge under plain Node (for the fake client and the real clients
// when no Electron is wanted). Usage: node mcp.mjs <userData>
import { runBridge } from './bridge.mjs';
import { ancestry } from './parent.mjs';

runBridge({ userData: process.argv[2], parent: () => ancestry() });
