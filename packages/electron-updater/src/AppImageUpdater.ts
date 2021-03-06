import { AllPublishOptions, CancellationToken, DownloadOptions, newError, UpdateInfo } from "builder-util-runtime"
import { execFileSync, spawn } from "child_process"
import isDev from "electron-is-dev"
import { chmod, unlinkSync } from "fs-extra-p"
import * as path from "path"
import "source-map-support/register"
import { BaseUpdater } from "./BaseUpdater"
import { FileWithEmbeddedBlockMapDifferentialDownloader } from "./differentialDownloader/FileWithEmbeddedBlockMapDifferentialDownloader"
import { UpdateCheckResult } from "./main"
import { findFile } from "./Provider"

export class AppImageUpdater extends BaseUpdater {
  constructor(options?: AllPublishOptions | null, app?: any) {
    super(options, app)
  }

  checkForUpdatesAndNotify(): Promise<UpdateCheckResult | null> {
    if (isDev) {
      return Promise.resolve(null)
    }

    if (process.env.APPIMAGE == null) {
      if (process.env.SNAP == null) {
        this._logger.warn("APPIMAGE env is not defined, current application is not an AppImage")
      }
      else {
        this._logger.info("SNAP env is defined, updater is disabled")
      }
      return Promise.resolve(null)
    }

    return super.checkForUpdatesAndNotify()
  }

  /*** @private */
  protected async doDownloadUpdate(updateInfo: UpdateInfo, cancellationToken: CancellationToken): Promise<Array<string>> {
    const provider = await this.provider
    const fileInfo = findFile(provider.resolveFiles(updateInfo), "AppImage")!!

    const requestHeaders = await this.computeRequestHeaders()
    const downloadOptions: DownloadOptions = {
      skipDirCreation: true,
      headers: requestHeaders,
      cancellationToken,
      sha512: fileInfo.info.sha512,
    }

    return await this.executeDownload({
      fileExtension: "AppImage",
      downloadOptions,
      fileInfo,
      updateInfo,
      task: async updateFile => {
        const oldFile = process.env.APPIMAGE!!
        if (oldFile == null) {
          throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
        }

        let isDownloadFull = false
        try {
          await new FileWithEmbeddedBlockMapDifferentialDownloader(fileInfo.info, this.httpExecutor, {
            newUrl: fileInfo.url.href,
            oldFile,
            logger: this._logger,
            newFile: updateFile,
            useMultipleRangeRequest: provider.useMultipleRangeRequest,
            requestHeaders,
          })
            .download()
        }
        catch (e) {
          this._logger.error(`Cannot download differentially, fallback to full download: ${e.stack || e}`)
          // during test (developer machine mac) we must throw error
          isDownloadFull = process.platform === "linux"
        }

        if (isDownloadFull) {
          await this.httpExecutor.download(fileInfo.url.href, updateFile, downloadOptions)
        }

        await chmod(updateFile, 0o755)
      },
    })
  }

  protected doInstall(installerPath: string, isSilent: boolean, isRunAfter: boolean): boolean {
    const appImageFile = process.env.APPIMAGE!!
    if (appImageFile == null) {
      throw newError("APPIMAGE env is not defined", "ERR_UPDATER_OLD_FILE_NOT_FOUND")
    }

    // https://stackoverflow.com/a/1712051/1910191
    unlinkSync(appImageFile)

    let destination: string
    if (path.basename(installerPath) === path.basename(appImageFile)) {
      // no version in the file name, overwrite existing
      destination = appImageFile
    }
    else {
      destination = path.join(path.dirname(appImageFile), path.basename(installerPath))
    }

    execFileSync("mv", ["-f", installerPath, destination])

    const env: any = {
      ...process.env,
      APPIMAGE_SILENT_INSTALL: "true",
    }

    if (isRunAfter) {
      spawn(destination, [], {
        detached: true,
        stdio: "ignore",
        env,
      })
        .unref()
    }
    else {
      env.APPIMAGE_EXIT_AFTER_INSTALL = "true"
      execFileSync(destination, [], {env})
    }
    return true
  }
}
