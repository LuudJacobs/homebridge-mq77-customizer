import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const script = fileURLToPath(new URL('../scripts/build-info.mjs', import.meta.url));

/**
 * Runs the labeller in a throwaway repository.
 *
 * It reads git and rewrites package.json, so it is worth running for real
 * rather than trusting a description of what it does.
 */
function label(branch: string | null): { info: Record<string, unknown>; displayName: string } {
  const directory = mkdtempSync(join(tmpdir(), 'mq77-label-'));
  mkdirSync(join(directory, 'dist'));
  mkdirSync(join(directory, 'scripts'));
  cpSync(script, join(directory, 'scripts', 'build-info.mjs'));
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'x', version: '1.2.3', displayName: 'MQ77 Customizer' }, null, 2),
  );

  const git = (...args: string[]) => execFileSync('git', args, { cwd: directory, stdio: 'ignore' });
  if (branch) {
    git('init', '-q', '-b', branch);
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '-A');
    git('commit', '-qm', 'first');
  }

  execFileSync('node', ['scripts/build-info.mjs'], { cwd: directory, stdio: 'ignore' });

  return {
    info: JSON.parse(readFileSync(join(directory, 'dist/build-info.json'), 'utf8')),
    displayName: JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')).displayName,
  };
}

describe('the build label', () => {
  it('shows the version on main', () => {
    const { info, displayName } = label('main');
    expect(info).toMatchObject({ branch: 'main', version: '1.2.3', released: true });
    expect(displayName).toBe('MQ77 Customizer');
  });

  it('names the branch anywhere else', () => {
    const { info, displayName } = label('develop');
    expect(info).toMatchObject({ branch: 'develop', released: false });
    expect(displayName).toBe('MQ77 Customizer #develop');
  });

  it('names a feature branch in full', () => {
    expect(label('feature/claude-something').displayName).toBe(
      'MQ77 Customizer #feature/claude-something',
    );
  });

  it('treats no git as released, which is what an npm install looks like', () => {
    const { info, displayName } = label(null);
    expect(info).toMatchObject({ branch: null, released: true });
    expect(displayName).toBe('MQ77 Customizer');
  });
});
