import { defineConfig } from 'tsdown'
import { typertPlugin } from '@deepseek-ai/dsh-typert-generator/tsdown'
import { sourceDecoratorsPlugin } from '../../script/source-decorators.mjs'

export default defineConfig({
  cwd: import.meta.dirname,
  entry: {
    index: 'src/index.ts',
    startup: 'src/startup.ts',
    settings: 'src/settings.ts',
    'types/types': 'src/types.ts',
    conversation: 'src/conversation.ts',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
  sourcemap: true,
  plugins: [sourceDecoratorsPlugin(), typertPlugin({ mode: 'package', faces: ['host'] })],
})
