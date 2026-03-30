import { ipcMain } from 'electron'
import { IPC } from '../../shared/constants'
import type { UpdateManager } from '../update/UpdateManager'

export function registerUpdateHandlers(updateManager: UpdateManager): void {
  ipcMain.handle(IPC.UPDATE_GET_STATE, async () => {
    return updateManager.getState()
  })

  ipcMain.handle(IPC.UPDATE_CHECK, async (_event, manual: boolean = true) => {
    return updateManager.checkForUpdates(manual)
  })

  ipcMain.handle(IPC.UPDATE_DOWNLOAD, async () => {
    return updateManager.downloadUpdate()
  })

  ipcMain.handle(IPC.UPDATE_INSTALL, async () => {
    return updateManager.quitAndInstall()
  })

  ipcMain.handle(IPC.UPDATE_OPEN_DOWNLOAD_PAGE, async () => {
    return updateManager.openDownloadPage()
  })
}
