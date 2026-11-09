import { performance } from 'node:perf_hooks'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { createCodeFreshness } from '../code-freshness.ts'
import { projectContext } from '../context-index.ts'

function summary(timings) {
  const sorted = [...timings].sort((a, b) => a - b)
  const percentile = fraction => Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3))
  return { p50_ms: percentile(0.5), p95_ms: percentile(0.95) }
}

async function sample(iterations, callback) {
  const timings = []
  for (let i = 0; i < iterations; i++) {
    const start = performance.now()
    await callback(i)
    timings.push(performance.now() - start)
  }
  return summary(timings)
}

const root = await mkdtemp(path.join(tmpdir(), 'opencode-bench-'))
try {
  await mkdir(path.join(root, 'src'), { recursive: true })
  for (const file of ['service.ts', 'ĐăngNhập.vue', 'My View.vue']) {
    await writeFile(path.join(root, 'src', file),
      `export const identifier = '${file}'\n` + '// source context\n'.repeat(80))
  }
  const guard = createCodeFreshness()
  const oneFile = await sample(200, () => {
    guard.track('single', { text: 'kiểm tra @src/service.ts' })
    return guard.context('single', root)
  })
  const threeFiles = await sample(200, () => {
    guard.track('multiple', { text: 'kiểm tra @src/service.ts, "src/My View.vue", `src/ĐăngNhập.vue`' })
    return guard.context('multiple', root)
  })
  guard.dispose()
  const firstIndex = await sample(1, () => projectContext(root))
  const warmIndex = await sample(200, () => projectContext(root))
  console.log(JSON.stringify({
    label: 'model-free local I/O and context latency (no inference)',
    iterations: 200,
    single_file: oneFile,
    three_files: threeFiles,
    project_map_cold: firstIndex,
    project_map_warm: warmIndex,
  }, null, 2))
} finally {
  await rm(root, { recursive: true, force: true })
}
