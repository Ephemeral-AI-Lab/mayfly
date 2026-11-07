/**
 * Type-only single point for the official Client Remote faces consumed by
 * Remote feature lanes. The api-remotes client entry re-exports these faces
 * from its own node_modules, where the sibling packages do not resolve, so a
 * consumer compilation must import each generated face itself; this module is
 * that single import, and it doubles as the compile-time probe that the faces
 * exist at the pinned dsh version.
 * @module @ephemeral-ai/mayfly/client/remote-face
 */

import type { ClientRemote } from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-account-controller/remote'
import type {} from '@deepseek-ai/dsh-api-account-controller/types'
import type {} from '@deepseek-ai/dsh-api-settings-controller/remote'
import type {} from '@deepseek-ai/dsh-api-settings-controller/types'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/remote'
import type {} from '@deepseek-ai/dsh-agent-preset-registry/types'
import type {} from '@deepseek-ai/dsh-permission-presets/remote'
import type {} from '@deepseek-ai/dsh-permission-presets/types'
import type {} from '@deepseek-ai/dsh-plugin-manager/remote'
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import type {} from '@deepseek-ai/dsh-plugin-market/remote'
import type {} from '@deepseek-ai/dsh-plugin-market/types'
import type {} from '@deepseek-ai/dsh-schedule/remote'

export type {
   BundleInfo,  ChangeResult,   
  ManagementError, 
       
      
       
    
} from '@deepseek-ai/dsh-plugin-manager/types'

/** Official plugin-manager namespace mounted by the api-remotes client handoff. */
export type ClientPluginManager = ClientRemote['pluginManager']
