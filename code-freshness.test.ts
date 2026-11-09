import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { createCodeFreshness } from './code-freshness.ts'

async function fixture(run: (root: string, file: string) => Promise<void>) {
  const temporary = await mkdtemp(path.join(tmpdir(), 'opencode-freshness-'))
  try {
    const root = await realpath(temporary)
    const file = path.join(root, 'src', 'record.service.ts')
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, [
      'export const getRecord = async () => {',
      '  return 1',
      '}',
      ...Array.from({ length: 75 }, () => '// padding'),
      'export const updateRecord = async () => {',
      '  return 2',
      '}',
    ].join('\n'))
    await run(root, file)
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

test('reads explicitly referenced code, verifies unchanged source, and skips ordinary chat', async () => fixture(async (root) => {
  const guard = createCodeFreshness()
  guard.track('chat', { text: 'kiểm tra @src/record.service.ts getRecord' })
  const initial = await guard.context('chat', root)
  assert.match(initial!, /Fresh saved source/)
  assert.match(initial!, /return 1/)
  assert.ok(initial!.length < 6000)

  guard.track('chat', { text: 'cải thiện hàm này' })
  assert.match((await guard.context('chat', root))!, /unchanged/)
  guard.track('chat', { text: 'cảm ơn bạn!' })
  assert.equal(await guard.context('chat', root), undefined)
  guard.dispose()
}))

test('shows a different function or changed saved file without stale excerpts', async () => fixture(async (root, file) => {
  const guard = createCodeFreshness()
  guard.track('chat', { text: '@src/record.service.ts getRecord' })
  await guard.context('chat', root)

  guard.track('chat', { text: 'sửa updateRecord' })
  const second = await guard.context('chat', root)
  assert.match(second!, /Fresh saved source/)
  assert.match(second!, /return 2/)
  assert.doesNotMatch(second!, /return 1/)

  await writeFile(file, 'export const updateRecord = async () => {\n  return 42\n}\n')
  guard.track('chat', { text: 'sửa updateRecord' })
  const changed = await guard.context('chat', root)
  assert.match(changed!, /return 42/)
  guard.dispose()
}))

test('rechecks native attachments without duplicating their source', async () => fixture(async (root, file) => {
  const guard = createCodeFreshness()
  guard.track('chat', { text: 'kiểm tra @src/record.service.ts', files: [{ uri: pathToFileURL(file).href }] })
  const result = await guard.context('chat', root)
  assert.match(result!, /already included in the attached-file prompt/)
  assert.doesNotMatch(result!, /return 1/)
  assert.equal(result!.match(/Current saved version checked/g)?.length, 1)
  guard.dispose()
}))

test('does not include files through symlinks outside the project', async () => fixture(async (root) => {
  const guard = createCodeFreshness()
  await symlink('/etc/hosts', path.join(root, 'src', 'secret.ts'))
  guard.track('chat', { text: 'kiểm tra @src/secret.ts' })
  assert.equal(await guard.context('chat', root), undefined)
  guard.dispose()
}))

test('recognizes three Unicode and quoted spaced paths without extra excerpts', async () => fixture(async (root) => {
  const files = [
    ['src/ĐăngNhập.vue', 'export const loginScreen = true'],
    ['src/My View.vue', 'export const spacedView = true'],
    ['src/utils/接続.ts', 'export const connection = true'],
  ]
  for (const [relative, source] of files) {
    const filename = path.join(root, relative)
    await mkdir(path.dirname(filename), { recursive: true })
    await writeFile(filename, source + '\n' + '// padding context\n'.repeat(160))
  }

  const guard = createCodeFreshness()
  guard.track('chat', { text: 'kiểm tra @src/ĐăngNhập.vue, `src/My View.vue` và "src/utils/接続.ts"' })
  const context = (await guard.context('chat', root))!
  for (const [, source] of files) assert.match(context, new RegExp(source))
  assert.equal(context.match(/Fresh saved source/g)?.length, 3)
  assert.ok(context.length < 10_000)
  guard.dispose()
}))

test('rechecks changed source after a successful edit invalidates the current turn', async () => fixture(async (root, file) => {
  const guard = createCodeFreshness()
  guard.track('chat', { text: '@src/record.service.ts getRecord' })
  assert.match((await guard.context('chat', root))!, /return 1/)

  await writeFile(file, 'export const getRecord = () => 99\n')
  guard.invalidate('chat')
  const updated = (await guard.context('chat', root))!
  assert.match(updated, /getRecord = \(\) => 99/)
  assert.doesNotMatch(updated, /return 1/)
  guard.dispose()
}))

test('an edit only re-injects modified source, preserving previously seen unchanged files', async () => fixture(async (root, file) => {
  const other = path.join(root, 'src', 'untouched.ts')
  await writeFile(other, 'export const untouchedValue = 123\n')
  const guard = createCodeFreshness()
  guard.track('chat', { text: '@src/record.service.ts và @src/untouched.ts' })
  assert.equal((await guard.context('chat', root))!.match(/Fresh saved source/g)?.length, 2)

  await writeFile(file, 'export const getRecord = () => 99\n')
  guard.invalidate('chat')
  const updated = (await guard.context('chat', root))!
  assert.match(updated, /getRecord = \(\) => 99/)
  assert.equal(updated.match(/Fresh saved source/g)?.length, 1)
  assert.match(updated, /untouched\.ts\] Saved source rechecked on disk, unchanged/)
  assert.doesNotMatch(updated, /untouchedValue = 123/)
  guard.dispose()
}))
