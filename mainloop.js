import { spawnSync } from 'node:child_process';

// Get the name of the current branch
const currentBranch = runGitCommand(['rev-parse', '--abbrev-ref', 'HEAD']);

// Get the number of commits ahead of master
const commitsAhead = runGitCommand(['rev-list', '--count', `master..${currentBranch}`]);

console.log(`The current branch (${currentBranch}) is ${commitsAhead} commit(s) ahead of master.`);

function runGitCommand(args) {
  const result = spawnSync('git', args, { encoding: 'utf-8' });
  
  if (result.error) {
    throw new Error(`Failed to execute git command: ${result.error.message}`);
  }
  
  if (result.status !== 0) {
    throw new Error(`Git command failed with status ${result.status}: ${result.stderr.trim()}`);
  }
  
  return result.stdout.trim();
}

