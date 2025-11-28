#!/usr/bin/env node

import * as core from '@actions/core';
import * as github from '@actions/github';
import { execSync } from 'child_process';
import {
  addToUnreleased,
  promoteUnreleasedToVersion,
  isEntryInChangelog,
  CommitEntry,
  getUnreleasedContent
} from '../lib/changelog';

interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  prNumber?: number;
}

/**
 * Execute a shell command and return the output
 */
function exec(command: string, options: { silent?: boolean } = {}): string {
  try {
    const result = execSync(command, {
      encoding: 'utf-8',
      stdio: options.silent ? 'pipe' : ['pipe', 'pipe', 'pipe']
    });
    return result.toString().trim();
  } catch (error: any) {
    if (options.silent) {
      return '';
    }
    throw error;
  }
}

/**
 * Get the most recent tag from git
 */
function getLatestTag(): string | null {
  try {
    const tag = exec('git describe --tags --abbrev=0', { silent: true });
    return tag || null;
  } catch {
    // No tags exist yet
    return null;
  }
}

/**
 * Get commits since a given ref (tag or commit)
 * If no ref is provided, gets all commits
 */
function getCommitsSince(ref: string | null): CommitInfo[] {
  const format = '%H|%s|%an';
  const range = ref ? `${ref}..HEAD` : 'HEAD';

  try {
    const output = exec(`git log ${range} --format="${format}"`, { silent: true });

    if (!output) {
      return [];
    }

    return output.split('\n').filter(line => line.trim()).map(line => {
      const [sha, message, author] = line.split('|');
      return {
        sha: sha.trim(),
        message: message.trim(),
        author: author.trim()
      };
    });
  } catch {
    return [];
  }
}

/**
 * Try to find the PR number associated with a commit
 */
async function enrichCommitWithPR(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  commit: CommitInfo
): Promise<CommitInfo> {
  try {
    // Check if the commit message already has a PR reference like "(#123)"
    const prMatch = commit.message.match(/\(#(\d+)\)$/);
    if (prMatch) {
      return { ...commit, prNumber: parseInt(prMatch[1], 10) };
    }

    // Try to find associated PRs via GitHub API
    const { data: prs } = await octokit.rest.repos.listPullRequestsAssociatedWithCommit({
      owner,
      repo,
      commit_sha: commit.sha
    });

    if (prs.length > 0) {
      // Use the first (most likely the merged) PR
      return { ...commit, prNumber: prs[0].number };
    }
  } catch (error: any) {
    core.debug(`Could not find PR for commit ${commit.sha}: ${error.message}`);
  }

  return commit;
}

/**
 * Filter commits to exclude merge commits and already-added entries
 */
function filterCommits(commits: CommitInfo[], changelogPath: string): CommitInfo[] {
  return commits.filter(commit => {
    // Skip merge commits
    if (commit.message.startsWith('Merge ')) {
      core.debug(`Skipping merge commit: ${commit.message}`);
      return false;
    }

    // Skip if already in changelog
    if (isEntryInChangelog(changelogPath, commit.message)) {
      core.debug(`Skipping already-tracked commit: ${commit.message}`);
      return false;
    }

    return true;
  });
}

/**
 * Convert CommitInfo to CommitEntry for the changelog
 */
function toCommitEntry(commit: CommitInfo): CommitEntry {
  // Clean up the message - remove PR reference if present (we'll add it back formatted)
  const cleanMessage = commit.message.replace(/\s*\(#\d+\)$/, '').trim();

  return {
    message: cleanMessage,
    author: commit.author,
    prNumber: commit.prNumber
  };
}

/**
 * Get the current date in YYYY-MM-DD format
 */
function getCurrentDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Check if the current event is a tag push
 */
function isTagPush(): boolean {
  const ref = process.env.GITHUB_REF || '';
  return ref.startsWith('refs/tags/');
}

/**
 * Extract tag name from GITHUB_REF
 */
function getTagName(): string | null {
  const ref = process.env.GITHUB_REF || '';
  if (!ref.startsWith('refs/tags/')) {
    return null;
  }
  return ref.replace('refs/tags/', '');
}

/**
 * Configure git for committing
 */
function configureGit(token: string): void {
  exec('git config --local user.name "github-actions[bot]"');
  exec('git config --local user.email "github-actions[bot]@users.noreply.github.com"');

  // Set up authentication
  const origin = exec('git remote get-url origin', { silent: true });
  if (origin.startsWith('https://')) {
    const authedUrl = origin.replace('https://', `https://x-access-token:${token}@`);
    exec(`git remote set-url origin ${authedUrl}`, { silent: true });
  }
}

/**
 * Commit and push changes
 */
function commitAndPush(changelogPath: string, message: string): void {
  exec(`git add ${changelogPath}`);

  // Check if there are changes to commit
  const status = exec('git status --porcelain', { silent: true });
  if (!status) {
    core.info('No changes to commit');
    return;
  }

  exec(`git commit -m "${message}"`);

  // Push to the current branch
  const branch = exec('git rev-parse --abbrev-ref HEAD', { silent: true });
  exec(`git push origin ${branch}`);

  core.info(`Committed and pushed changes to ${branch}`);
}

/**
 * Handle push to main branch - add new commits to Unreleased section
 */
async function handleMainPush(
  octokit: ReturnType<typeof github.getOctokit>,
  owner: string,
  repo: string,
  changelogPath: string,
  unreleasedHeader: string
): Promise<void> {
  core.info('Handling push to main branch');

  // Get the latest tag
  const latestTag = getLatestTag();
  core.info(latestTag ? `Latest tag: ${latestTag}` : 'No existing tags found');

  // Get commits since the last tag
  const commits = getCommitsSince(latestTag);
  core.info(`Found ${commits.length} commits since ${latestTag || 'beginning'}`);

  if (commits.length === 0) {
    core.info('No new commits to process');
    return;
  }

  // Filter out merge commits and already-tracked entries
  const newCommits = filterCommits(commits, changelogPath);
  core.info(`${newCommits.length} commits after filtering`);

  if (newCommits.length === 0) {
    core.info('All commits are already in the changelog');
    return;
  }

  // Enrich commits with PR numbers
  core.info('Looking up PR numbers for commits...');
  const enrichedCommits = await Promise.all(
    newCommits.map(commit => enrichCommitWithPR(octokit, owner, repo, commit))
  );

  // Convert to changelog entries
  const entries = enrichedCommits.map(toCommitEntry);

  // Log what we're adding
  core.info(`Adding ${entries.length} entries to changelog:`);
  entries.forEach(entry => {
    const prSuffix = entry.prNumber ? ` (#${entry.prNumber})` : '';
    core.info(`  - ${entry.message} by ${entry.author}${prSuffix}`);
  });

  // Add to changelog
  addToUnreleased(changelogPath, entries, unreleasedHeader);
  core.info(`Updated ${changelogPath}`);
}

/**
 * Handle tag push - promote Unreleased to version section
 */
function handleTagPush(
  changelogPath: string,
  unreleasedHeader: string
): void {
  const tagName = getTagName();
  if (!tagName) {
    throw new Error('Could not extract tag name from GITHUB_REF');
  }

  core.info(`Handling tag push: ${tagName}`);

  // Check if there's content in unreleased
  const unreleasedContent = getUnreleasedContent(changelogPath, unreleasedHeader);
  if (!unreleasedContent) {
    core.warning('Unreleased section is empty - nothing to promote');
    return;
  }

  // Promote unreleased to version
  const date = getCurrentDate();
  promoteUnreleasedToVersion(changelogPath, tagName, date, unreleasedHeader);

  core.info(`Promoted Unreleased section to ${tagName} (${date})`);
}

async function main(): Promise<void> {
  try {
    // Get inputs
    const changelogPath = core.getInput('changelog') || './CHANGES.md';
    const unreleasedHeader = core.getInput('unreleased-header') || '## Unreleased';
    const token = core.getInput('github-token', { required: true });

    // Get repository info
    const [owner, repo] = (process.env.GITHUB_REPOSITORY || '').split('/');
    if (!owner || !repo) {
      throw new Error('Could not determine repository from GITHUB_REPOSITORY');
    }

    // Create Octokit instance
    const octokit = github.getOctokit(token);

    // Configure git for pushing
    configureGit(token);

    // Determine what type of event we're handling
    if (isTagPush()) {
      // Tag push - promote Unreleased to version
      handleTagPush(changelogPath, unreleasedHeader);

      // Commit and push the changes
      const tagName = getTagName();
      commitAndPush(changelogPath, `chore: release ${tagName}`);
    } else {
      // Branch push - add commits to Unreleased
      await handleMainPush(octokit, owner, repo, changelogPath, unreleasedHeader);

      // Commit and push the changes
      commitAndPush(changelogPath, 'chore: update changelog');
    }

    core.info('Changelog update complete!');
  } catch (error: any) {
    core.setFailed(`Failed to update changelog: ${error.message}`);
    process.exit(1);
  }
}

main();

export {
  getLatestTag,
  getCommitsSince,
  filterCommits,
  toCommitEntry,
  isTagPush,
  getTagName
};

