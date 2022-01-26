const _platform = Deno.build.os

export const isWin = _platform === "windows"
export const isMac = _platform === "darwin"
export const isLinux = _platform === "linux"
