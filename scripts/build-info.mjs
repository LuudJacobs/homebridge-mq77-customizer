// Which branch this build came from, decided at build time.
//
// Written to `dist`, which git ignores, so a build never leaves the working
// tree dirty. Labelling the plugin's name in the Homebridge interface would
// mean rewriting package.json on every build, which is not worth the churn.
//
// Nothing about an installed package says where it came from: npm leaves no
// `.git`, no `_resolved` and no `gitHead`. During `prepare` npm's clone is a
// real work tree checked out on the branch, so that is the moment to look, and
// `prepare` runs `build`, which means a local checkout is labelled too.
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

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

// On stderr, so `npm pack --json` gets JSON and nothing else.
console.error(`Build labelled ${released ? packageJson.version : `#${branch}`}`);
