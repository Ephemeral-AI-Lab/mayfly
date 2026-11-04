/** Renderer row maps for semantic document anchors. @module */
import type { MayflyUiNode } from '@ephemeral-ai/mayfly-ui'
import { indexContent, type ContentIndex } from './content-segments.ts'
import { documentRowsSource, type ContentRowsEnv } from './content-rows.ts'
import { documentBlockText, type DocumentBlockSource, type DocumentResolver, type UiDocumentBlock } from './ui-interaction-document.ts'

/**
 * A document's estimate for a block whose rows no content source maps (forms, lists, charts): the text is indexed
 * once, and each width carries a lazily built prefix over the same estimate model the segmented sources use.
 */
const estimatedDocuments = new WeakMap<object, { readonly text: string, readonly index: ContentIndex, readonly sources: Map<number, DocumentBlockSource> }>()

function estimatedBlockSource(node: MayflyUiNode, width: number): DocumentBlockSource {
  let held = estimatedDocuments.get(node)
  if (held === undefined) {
    const text = documentBlockText({ id: '', node })
    held = { text, index: indexContent(text), sources: new Map() }
    estimatedDocuments.set(node, held)
  }
  const safe = Math.max(1, Math.floor(width))
  let source = held.sources.get(safe)
  if (source === undefined) {
    if (held.sources.size >= 4) held.sources.delete(held.sources.keys().next().value!)
    const { index, text } = held
    let prefixes: number[] | undefined
    const prefix = (): number[] => {
      if (prefixes === undefined) {
        prefixes = new Array<number>(index.segments + 1).fill(0)
        for (let segment = 0; segment < index.segments; segment += 1) prefixes[segment + 1] = prefixes[segment]! + index.estimateRows(segment, safe)
      }
      return prefixes
    }
    source = {
      get length() { return prefix()[index.segments]! },
      rowOf(offset) {
        const segment = index.segmentAtOffset(offset)
        return prefix()[segment]! + index.rowOfOffset(segment, offset, safe, text)
      },
      offsetOf(row) {
        const bounds = prefix()
        let low = 0, high = index.segments - 1
        while (low < high) {
          const middle = (low + high + 1) >> 1
          if (bounds[middle]! <= row) low = middle
          else high = middle - 1
        }
        return index.offsetOfRow(low, Math.max(0, row - bounds[low]!), safe, text)
      },
    }
    held.sources.set(safe, source)
  }
  return source
}

/** A proportional map over a real row length: bounded blocks that keep no offset map of their own. */
function proportionalBlockSource(length: () => number, units: number): DocumentBlockSource {
  return {
    get length() { return length() },
    rowOf(offset) {
      const rows = length()
      return rows <= 1 ? 0 : Math.min(rows - 1, Math.floor((Math.max(0, Math.min(units, offset)) * rows) / Math.max(1, units)))
    },
    offsetOf(row) {
      const rows = length()
      return Math.min(units, Math.floor((Math.max(0, Math.min(Math.max(0, rows - 1), row)) * units) / Math.max(1, rows)))
    },
  }
}

/** The kinds whose shared source maps offsets in the same text space `sourceText` produces. */
const MAPPED_KINDS = new Set(['text', 'code', 'rich-text', 'markdown'])

/**
 * The block's row map at `width`: the shared segmented source for the kinds whose offsets ride it, a proportional
 * map over the shared source's real length for the other content kinds, or an index estimate for everything else.
 */
function documentBlockSource(block: UiDocumentBlock, width: number, env: ContentRowsEnv): DocumentBlockSource {
  const safe = Number.isFinite(width) ? Math.max(1, Math.floor(width)) : 1
  const source = documentRowsSource(block.node, safe, env)
  if (source !== undefined && MAPPED_KINDS.has(block.node.kind) && source.rowOf !== undefined && source.offsetOf !== undefined) {
    return { get length() { return source.length }, rowOf: offset => source.rowOf!(offset), offsetOf: row => source.offsetOf!(row) }
  }
  if (source !== undefined) return proportionalBlockSource(() => source.length, documentBlockText(block).length)
  return estimatedBlockSource(block.node, safe)
}

/** One resolver for a compiled surface: every block's map shares the env the leaves paint with. */
export function documentResolver(env: ContentRowsEnv): DocumentResolver {
  return (block, width) => documentBlockSource(block, width, env)
}

