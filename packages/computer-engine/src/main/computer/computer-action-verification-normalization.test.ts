// 修改声明（FreeCodeZ）：测试运行器自 vitest 迁写为 node:test + node:assert，
// 用例名、夹具与断言语义与 orca 1.4.214 原件等价；产码未动。原版权见 ../LICENSE。
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ComputerActionResult } from '../../shared/runtime-types'
import { normalizeComputerActionResult } from './computer-action-verification-normalization'

describe('normalizeComputerActionResult', () => {
  it('marks accessibility actions without a post-state assertion as unverified', () => {
    const result: ComputerActionResult = {
      snapshot: {
        id: 'snap-1',
        app: { name: 'Finder', bundleId: 'com.apple.finder', pid: 100 },
        window: { title: 'Finder', id: 42, width: 800, height: 600 },
        coordinateSpace: 'window',
        treeText: 'tree',
        elementCount: 1,
        focusedElementId: null
      },
      screenshot: null,
      screenshotStatus: { state: 'skipped', reason: 'no_screenshot_flag' },
      action: { path: 'accessibility', actionName: 'click' }
    }

    assert.deepStrictEqual(normalizeComputerActionResult(result).action?.verification, {
      state: 'unverified',
      reason: 'accessibility_action_unasserted'
    })
  })
})
