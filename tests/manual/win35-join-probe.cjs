const { Client } = require('ssh2');
const { readFileSync } = require('fs');
const os = require('os');
const path = require('path');

// Join probe: exec-with-pty exactly like the app's openExecWithPty, then
// interact briefly so a live join has a reason to paint. Streams raw bytes.
const key = readFileSync(path.join(os.homedir(), '.ssh', 'id_win35'));
const command = process.argv[2];
const MS = Number(process.argv[3] ?? 12000);

const conn = new Client();
conn.on('ready', () => {
  conn.exec(command, { pty: { term: 'xterm-256color', cols: 120, rows: 30 } }, (err, stream) => {
    if (err) { console.error('exec err:', err.message); conn.end(); return; }
    stream.on('data', (d) => { process.stdout.write(d); });
    stream.stderr.on('data', (d) => { process.stdout.write('[stderr]'); process.stdout.write(d); });
    stream.on('close', (code) => { console.log(`\n[channel closed code=${code}]`); conn.end(); process.exit(0); });
    setTimeout(() => { stream.write('\r'); }, 4000);
    setTimeout(() => { stream.write('exit\r'); }, 8000);
    setTimeout(() => { try { stream.close(); } catch {} conn.end(); process.exit(0); }, MS);
  });
}).connect({
  host: '192.168.86.35',
  port: 22,
  username: 'User',
  privateKey: key,
  readyTimeout: 10000,
});
