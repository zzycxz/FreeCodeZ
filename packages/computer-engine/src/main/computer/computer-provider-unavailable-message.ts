export function computerProviderUnavailableMessage(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return [
      'computer-use has no native provider for darwin because FreeCodeZ Computer Use.app was not found or this macOS version is unsupported.',
      'For local development, run node packages/computer-engine/scripts/build-computer-macos.mjs and restart FreeCodeZ from this worktree.'
    ].join(' ')
  }
  if (platform === 'linux' || platform === 'win32') {
    return `computer-use has no native provider for ${platform}; the platform runtime file was not found`
  }
  return `computer-use has no native provider for ${platform}`
}
