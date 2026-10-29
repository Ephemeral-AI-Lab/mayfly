import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'

export default defineConfig({
  cwd: import.meta.dirname,
  entry: {
    index: 'src/index.ts',
    startup: 'src/startup.ts',
    settings: 'src/settings.ts',
    'types/types': 'src/types.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  plugins: [typertPlugin({ mode: 'package', faces: ['host'] })],
})
