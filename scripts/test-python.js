'use strict';
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const command = process.platform === 'win32' ? 'py' : 'python3';
const args = process.platform === 'win32' ? ['-3'] : [];
args.push('-X', 'utf8', '-m', 'unittest', 'discover', '-s', 'test', '-p', 'test_*.py');
const result = spawnSync(command, args, { cwd: path.resolve(__dirname, '..'), stdio: 'inherit', windowsHide: true });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
