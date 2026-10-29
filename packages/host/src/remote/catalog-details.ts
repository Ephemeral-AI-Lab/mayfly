/** Session skill details, adapter model details, and resolved permission bundles. @module */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-permission-presets'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type { MayflyDefaultModelRequest, MayflyModelCatalogDetails, MayflyModelSelection, MayflyPermissionCatalogDetails, MayflyPermissionCatalogRequest, MayflyPermissionSpec, MayflySkillCatalog, MayflySkillSummary } from '../types.ts'
import { frozen } from './json.ts'
import { resolveExactAgent, sessionDirectory } from './session.ts'

/** Discover user-invocable skills with their native source/provider fields. */
export async function skillCatalog(ctx: Context, sessionId: Parameters<typeof resolveExactAgent>[1], signal: AbortSignal): Promise<MayflySkillCatalog> {
  const agent = await resolveExactAgent(ctx, sessionId, signal)
  const snapshot = await ctx.skills.snapshot({ cwd: sessionDirectory(ctx, agent.session), scope: agent, signal })
  const skills = snapshot.skills.filter(skill => skill.invocation.userInvocable).map((skill): MayflySkillSummary => ({
    ...skill.path === undefined ? {} : { path: skill.path },
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse },
    source: skill.source,
    provider: skill.provider,
    modelInvocable: skill.invocation.modelInvocable,
  }))
  return frozen({ skills, complete: snapshot.complete })
}

/** Resolve every advertised model's context and reasoning metadata through its owning adapter. */
export async function modelCatalogDetails(ctx: Context, providerFilter: string | undefined, signal: AbortSignal): Promise<MayflyModelCatalogDetails> {
  const providers = ctx.llm.listProviders()
  if (providerFilter !== undefined && !providers.some(provider => provider.id === providerFilter)) {
    throw new Error(`provider "${providerFilter}" is not registered`)
  }
  const labels = new Map(providers.map(provider => [provider.id, provider.name.length > 0 ? provider.name : provider.id]))
  const rows: { provider: string, id: string, name: string }[] = []
  for (const provider of providers) {
    if (providerFilter !== undefined && provider.id !== providerFilter) continue
    try {
      const models = await ctx.llm.listModels(provider.id)
      for (const model of models) rows.push({ provider: provider.id, id: model.id, name: model.name.length > 0 ? model.name : model.id })
    } catch {
      // An unavailable advisory provider contributes no rows.
    }
  }
  const infos = await Promise.allSettled(rows.map(row => ctx.llm.resolveModelInfo(row.provider, row.id, signal)))
  signal.throwIfAborted()
  return frozen({
    items: rows.map((row, index) => {
      const info = infos[index]?.status === 'fulfilled' ? infos[index].value : undefined
      const reasoning = info?.reasoning
      const efforts = reasoning !== undefined && reasoning.efforts.length > 0
        ? reasoning.efforts.map(effort => String(effort.id))
        : undefined
      return {
        ...row,
        providerLabel: labels.get(row.provider) ?? row.provider,
        ...info?.context?.contextWindow === undefined ? {} : { contextWindow: info.context.contextWindow },
        ...efforts === undefined ? {} : { efforts },
        ...reasoning?.defaultEffort === undefined ? {} : { defaultEffort: String(reasoning.defaultEffort) },
      }
    }),
  })
}

/** Read or save the Session-independent default through the real native owner. */
export async function defaultModel(ctx: Context, request: MayflyDefaultModelRequest, signal: AbortSignal): Promise<MayflyModelSelection> {
  signal.throwIfAborted()
  if (request.operation === 'select') {
    await ctx.agentDefaultModel.saveSelection({
      provider: request.provider,
      model: request.model,
      ...request.reasoningEffort === undefined ? {} : { reasoningEffort: ReasoningEffortId(request.reasoningEffort) },
    })
    signal.throwIfAborted()
  }
  const selected = ctx.agentDefaultModel.currentSelection()
  return frozen({
    provider: selected.provider,
    model: selected.model,
    ...selected.reasoningEffort === undefined ? {} : { reasoningEffort: String(selected.reasoningEffort) },
  })
}

/** Resolve every permission option's native sandbox/approval bundle and optional current yolo value. */
export function permissionCatalogDetails(ctx: Context, request: MayflyPermissionCatalogRequest, signal: AbortSignal): MayflyPermissionCatalogDetails {
  signal.throwIfAborted()
  const catalog = ctx.permissionPresets.catalog()
  const specs = Object.create(null) as Record<string, MayflyPermissionSpec>
  for (const option of catalog.options) {
    const spec = ctx.permissionPresets.resolve(option.value)
    specs[option.value] = { sandbox: spec.sandbox, approval: spec.approval }
  }
  let yolo = false
  if (request.currentPreset !== undefined) {
    try {
      const spec = ctx.permissionPresets.resolve(request.currentPreset)
      yolo = spec.sandbox === 'danger-full-access' && spec.approval === 'never'
    } catch {
      // A withdrawn or derived current value is not a yolo bundle.
    }
  }
  return frozen({ ...catalog, specs, yolo })
}
