import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createToolLoopGuard } from './tool-loop-guard.ts'

test('stops three identical failures; a new user turn restores tools', () => {
  const guard = createToolLoopGuard()
  for (let i = 0; i < 3; i++) {
    guard.before('chat', String(i), 'read', { path: 'missing.ts' })
    guard.after(String(i), 'error')
  }
  assert.match(guard.reason('chat') ?? '', /thất bại 3 lần/)
  assert.throws(() => guard.before('chat', 'fourth', 'read', { path: 'missing.ts' }))
  guard.reset('chat')
  assert.doesNotThrow(() => guard.before('chat', 'new-turn', 'read', { path: 'missing.ts' }))
})

test('allows distinct inputs and fresh reads after a successful edit', () => {
  const guard = createToolLoopGuard()
  for (let i = 0; i < 3; i++) {
    guard.before('chat', String(i), 'read', { path: 'model.ts' })
    guard.after(String(i), 'completed')
  }
  assert.equal(guard.reason('chat'), undefined)
  guard.before('chat', 'other', 'read', { path: 'service.ts' })
  guard.after('other', 'completed')
  guard.before('chat', 'edit', 'edit', { path: 'model.ts' })
  guard.after('edit', 'completed')
  assert.doesNotThrow(() => guard.before('chat', 'verify', 'read', { path: 'model.ts' }))
})

test('blocks a fourth identical read regardless of input key order', () => {
  const guard = createToolLoopGuard()
  for (let i = 0; i < 3; i++) {
    guard.before('chat', String(i), 'read', { path: 'model.ts', offset: 0 })
    guard.after(String(i), 'completed')
  }
  assert.throws(() => guard.before('chat', 'again', 'read', { offset: 0, path: 'model.ts' }))
  assert.match(guard.reason('chat') ?? '', /3 lần/)
})

test('late results from the previous turn cannot block the new turn or another chat', () => {
  const guard = createToolLoopGuard()
  for (let i = 0; i < 3; i++) guard.before('chat', String(i), 'read', { path: 'missing.ts' })
  guard.reset('chat')
  for (let i = 0; i < 3; i++) guard.after(String(i), 'error')
  assert.equal(guard.reason('chat'), undefined)
  assert.doesNotThrow(() => guard.before('other-chat', 'other', 'read', { path: 'missing.ts' }))
  guard.clear()
  assert.equal(guard.reason('other-chat'), undefined)
})
