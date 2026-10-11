import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

const HELPER_APP_RELATIVE = 'native/computer-use-macos/.build/release/FreeCodeZ Computer Use.app'

/** dev 候选（纯函数，测试直测）：同一份引擎源码会被打进三种深度的产物——
 * sidecar esbuild 产物（dist/ → 上1层=包根）、源码 tsx（src/main/computer/ → 上3层=包根，
 * 原实现误写上2层、从未命中过）、desktop main tsup 产物（out/main/ → 上3层=packages/
 * 再入 computer-engine）。
 * 2026-10-11 装机审计（G2）：原先只有（错误的）源码深度一条相对候选，sidecar/desktop
 * 打包后 import.meta.dirname 变浅导致 dev 态 helper 全落空（装机态被 resourcesPath 救住）。 */
export function macOSHelperAppDevCandidates(dirname: string): string[] {
  return [
    resolve(dirname, `../${HELPER_APP_RELATIVE}`),
    resolve(dirname, `../../../${HELPER_APP_RELATIVE}`),
    resolve(dirname, `../../../computer-engine/${HELPER_APP_RELATIVE}`),
  ];
}

export function resolveMacOSComputerUseAppPath(): string | null {
  const override = process.env.FREECODEZ_COMPUTER_MACOS_HELPER_APP_PATH
  if (override && existsSync(override)) {
    return override
  }

  // W-11 打包态布局：extraResources 放到 resources/cua-helper/FreeCodeZ Computer Use.app。
  const packaged = [
    join(process.resourcesPath ?? '', 'cua-helper', 'FreeCodeZ Computer Use.app'),
    join(process.resourcesPath ?? '', 'FreeCodeZ Computer Use.app'),
  ]
  const dev = [
    join(process.cwd(), HELPER_APP_RELATIVE),
    ...macOSHelperAppDevCandidates(import.meta.dirname ?? ''),
  ]
  const candidates = process.resourcesPath ? [...packaged, ...dev] : dev

  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? null
}

export function resolveMacOSComputerUseExecutablePath(): string | null {
  const appPath = resolveMacOSComputerUseAppPath()
  if (!appPath) {
    return null
  }
  const executablePath = join(appPath, 'Contents', 'MacOS', 'freecodez-computer-use-macos')
  return existsSync(executablePath) ? executablePath : null
}
