/** Cooperative external settings writer using the native profile lock. @module */
import { once } from 'node:events'
import { pathToFileURL } from 'node:url'

const { withFileLock, writeFileAtomic } = await import(pathToFileURL(process.argv[2]).href)
await withFileLock(process.argv[3], async () => {
  process.send('locked')
  await once(process, 'message')
  await writeFileAtomic(process.argv[4], 'external', { mode: 0o600 })
})
process.disconnect()
