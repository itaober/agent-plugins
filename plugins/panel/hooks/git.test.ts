import { expect, test } from 'claude-code/testing'

import type { GitInfo, UrlEntry } from '../types'
import { GLYPH } from './section'
import { glyphOf, LABEL, issueState, prState, sortGit } from './sections/git'

const entry = (repo: string, kind: 'pr' | 'issue', number: number): UrlEntry => ({
  key: `${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
  url: `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${number}`,
  desc: `#${number}`,
  rank: 4,
  git: { kind, repo, number },
})

test('maps a PR by priority: merged, closed, draft, CI, review decision', async () => {
  const failing = [{ conclusion: 'SUCCESS' }, { conclusion: 'FAILURE' }]
  expect(prState({ state: 'MERGED', isDraft: true, statusCheckRollup: failing })).toBe('merged')
  expect(prState({ state: 'CLOSED', isDraft: true })).toBe('closed')
  expect(prState({ state: 'OPEN', isDraft: true, statusCheckRollup: failing })).toBe('draft')
  expect(prState({ state: 'OPEN', reviewDecision: 'APPROVED', statusCheckRollup: failing })).toBe('ci-failed')
  expect(prState({ state: 'OPEN', reviewDecision: 'APPROVED', statusCheckRollup: [{ state: 'ERROR' }] })).toBe('ci-failed')
  expect(prState({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' })).toBe('changes-requested')
  expect(prState({ state: 'OPEN', reviewDecision: 'APPROVED', statusCheckRollup: null })).toBe('approved')
  expect(prState({ state: 'OPEN', reviewDecision: '' })).toBe('review')
})

test('maps an issue: open, completed, closed', async () => {
  expect(issueState({ state: 'OPEN' })).toBe('open')
  expect(issueState({ state: 'CLOSED', stateReason: 'COMPLETED' })).toBe('completed')
  expect(issueState({ state: 'CLOSED', stateReason: 'NOT_PLANNED' })).toBe('closed')
})

test('names states in English', async () => {
  expect(LABEL[prState({ state: 'OPEN', statusCheckRollup: [{ conclusion: 'TIMED_OUT' }] })]).toBe('CI failed')
  expect(LABEL[prState({ state: 'OPEN', reviewDecision: 'CHANGES_REQUESTED' })]).toBe('Changes')
  expect(LABEL[issueState({ state: 'CLOSED', stateReason: 'COMPLETED' })]).toBe('Done')
  expect(LABEL.unknown).toBe('')
})

test('sorts Git rows by attention, recency or repo', async () => {
  // urls order: most recently seen first
  const rows = [
    entry('z/app', 'pr', 1),
    entry('a/lib', 'pr', 2),
    entry('z/app', 'issue', 3),
    entry('a/lib', 'pr', 4),
    entry('z/app', 'pr', 5),
    entry('a/lib', 'pr', 6),
  ]
  const known: Record<string, GitInfo> = {
    'z/app/pull/1': { state: 'merged' },
    'a/lib/pull/2': { state: 'approved' },
    'z/app/issues/3': { state: 'open' },
    'a/lib/pull/4': { state: 'ci-failed' },
    'z/app/pull/5': { state: 'review' },
    'a/lib/pull/6': { state: 'changes-requested' },
  }
  const numbers = (mode: 'attention' | 'recent' | 'repo') => sortGit(rows, known, mode).map(u => Number(u.key.split('/').pop()))
  expect(numbers('attention')).toEqual([4, 6, 5, 2, 3, 1])
  expect(numbers('recent')).toEqual([1, 2, 3, 4, 5, 6])
  expect(numbers('repo')).toEqual([4, 6, 2, 5, 3, 1])
})

test('picks the PR glyph by state; issues keep one glyph', async () => {
  expect(glyphOf('pr', 'merged')).toBe(GLYPH.prMerged)
  expect(glyphOf('pr', 'closed')).toBe(GLYPH.prClosed)
  expect(glyphOf('pr', 'draft')).toBe(GLYPH.prDraft)
  expect(glyphOf('pr', 'review')).toBe(GLYPH.pr)
  expect(glyphOf('pr', undefined)).toBe(GLYPH.pr)
  expect(glyphOf('issue', 'closed')).toBe(GLYPH.issue)
})
