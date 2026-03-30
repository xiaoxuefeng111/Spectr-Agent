/**
 * Main process logger — wraps electron-log v5 and redirects console.* to file.
 *
 * Call logger.initialize() once at app startup before any other code runs.
 */
import log from 'electron-log/main'

// Write to {userData}/logs/main.log
log.transports.file.maxSize = 5 * 1024 * 1024  // 5 MB
log.transports.file.level = 'debug'
log.transports.console.level = 'debug'

// Redirect all console.* calls to electron-log so they also go to file
Object.assign(console, log.functions)

export { log as logger }
export default log
