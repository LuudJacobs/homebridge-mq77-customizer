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
    if (branch && branch !== 'HEAD') {
      return branch;
    }
  } catch {
    // No git at all, which is what an npm install looks like.
  }
  // A build on GitHub checks the branch out detached, and says which it was
  // here instead. This is how a test tarball knows it is not a release.
  return process.env.GITHUB_REF_NAME || null;
}

const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const branch = branchName();
// A version with a tail on it (`1.6.0-test.12`) was stamped for one build and
// never released, whatever branch it was cut from. Nothing else says so: an
// install from a hosted git URL is unpacked from a tarball with no git in it,
// so the branch cannot be asked for at that point.
const stamped = packageJson.version.includes('-');
const released = (branch === null || branch === 'main') && !stamped;

writeFileSync(
  'dist/build-info.json',
  `${JSON.stringify({ branch, version: packageJson.version, released }, null, 2)}\n`,
);

// On stderr, so `npm pack --json` gets JSON and nothing else.
console.error(
  `Build labelled ${released ? packageJson.version : branch ? `#${branch}` : packageJson.version}`,
);
