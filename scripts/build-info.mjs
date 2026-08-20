// Which branch this build came from, decided at build time.
//
// Nothing about an installed package says where it came from: npm leaves no
// `.git`, no `_resolved` and no `gitHead`. During `prepare` npm's clone is a
// real work tree checked out on the branch, so that is the moment to look, and
// `prepare` runs `build`, which means a local checkout is labelled too.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const BASE_NAME = 'MQ77 Customizer';

function branchName() {
  try {
    const branch = execSync('git rev-parse --abbrev-ref HEAD', {
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim();
    // Detached, so there is no branch to name.
    return branch && branch !== 'HEAD' ? branch : null;
  } catch {
    // No git at all, which is what an npm install looks like.
    return null;
  }
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const branch = branchName();
const released = branch === null || branch === 'main';

writeFileSync(
  'dist/build-info.json',
  `${JSON.stringify({ branch, version: packageJson.version, released }, null, 2)}\n`,
);

// The Homebridge interface reads the plugin's name from package.json and has
// no other way to be told, so the name itself carries the branch.
const displayName = released ? BASE_NAME : `${BASE_NAME} #${branch}`;
if (packageJson.displayName !== displayName) {
  packageJson.displayName = displayName;
  writeFileSync('package.json', `${JSON.stringify(packageJson, null, 2)}\n`);
}

console.log(`Build labelled ${released ? packageJson.version : `#${branch}`}`);
