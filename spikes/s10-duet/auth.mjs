// Spike S10: sign-in state from each CLI's own protocol. Prints only exit codes and the auth
// method/type, never the JSON (it can hold account details) and never a credential file.
import { execFile } from 'node:child_process';

const run = (cmd, args) =>
  new Promise((done) => execFile(cmd, args, { windowsHide: true, timeout: 20000 }, (err, stdout) => done({ code: err ? (err.code ?? 1) : 0, stdout })));

const claude = process.argv[2];
const codex = process.argv[3];
if (claude) {
  const c = await run(claude, ['auth', 'status']);
  let method;
  try {
    method = JSON.parse(c.stdout).authMethod;
  } catch {
    method = 'unreadable';
  }
  console.log(`claude auth status: exit=${c.code} authMethod=${method}`);
}
if (codex) {
  const c = await run(codex, ['login', 'status']);
  console.log(`codex login status: exit=${c.code}`);
}
