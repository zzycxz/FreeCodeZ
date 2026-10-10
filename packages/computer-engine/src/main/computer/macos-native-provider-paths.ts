import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'

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
    join(process.cwd(), 'native/computer-use-macos/.build/release/FreeCodeZ Computer Use.app'),
    resolve(import.meta.dirname, '../../native/computer-use-macos/.build/release/FreeCodeZ Computer Use.app')
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
