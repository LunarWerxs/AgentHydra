// Resolver for Claude Code binary: checks SDK's platform package, cache, or downloads from npm.
// Concurrent calls to resolve() serialize downloads to avoid waste.

import { createWriteStream } from 'node:fs'
import { readFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { createInflateRaw } from 'node:zlib'
import { homedir } from 'node:os'
import { join, extname, basename } from 'node:path'
import { Readable } from 'node:stream'

interface PlatformPackageInfo {
  name: string
  binaryPath: string
}

let downloadInProgress: Promise<string> | null = null
let downloadError: Error | null = null

/** Get platform package name like the SDK does (matches sdk.mjs logic). */
function getPlatformPackageName(): string {
  const platform = process.platform as 'linux' | 'darwin' | 'win32' | NodeJS.Platform
  const arch = process.arch as 'x64' | 'arm64' | string

  if (platform === 'linux') {
    const musl = isMusl()
    const archSuffix = arch === 'arm64' ? 'arm64' : 'x64'
    const muslSuffix = musl ? '-musl' : ''
    return `@anthropic-ai/claude-agent-sdk-linux-${archSuffix}${muslSuffix}`
  } else if (platform === 'darwin') {
    const archSuffix = arch === 'arm64' ? 'arm64' : 'x64'
    return `@anthropic-ai/claude-agent-sdk-darwin-${archSuffix}`
  } else if (platform === 'win32') {
    const archSuffix = arch === 'arm64' ? 'arm64' : 'x64'
    return `@anthropic-ai/claude-agent-sdk-win32-${archSuffix}`
  }
  throw new Error(`unsupported platform: ${platform}`)
}

function isMusl(): boolean {
  try {
    const { execSync } = require('node:child_process')
    const libc = execSync('getconf GNU_LIBC_VERSION 2>&1 || echo ""', { encoding: 'utf8' }).trim()
    return !libc || libc.includes('musl')
  } catch {
    return false
  }
}

function getBinaryName(): string {
  return process.platform === 'win32' ? 'claude.exe' : 'claude'
}

/** Check if a platform package is installed. */
function checkInstalledPackage(): PlatformPackageInfo | null {
  const packageName = getPlatformPackageName()
  try {
    const packagePath = require.resolve(packageName)
    const pkgDir = packagePath.split('node_modules').slice(0, 2).join('node_modules')
    const binaryName = getBinaryName()
    const binaryPath = join(pkgDir, 'node_modules', packageName, binaryName)
    if (existsSync(binaryPath)) {
      return { name: packageName, binaryPath }
    }
  } catch {
    // package not installed
  }
  return null
}

/** Check if a cached copy exists. */
function checkCachedCopy(home: string, sdkVersion: string): string | null {
  const packageName = getPlatformPackageName()
  const binaryName = getBinaryName()
  const cachePath = join(home, 'claude-code', sdkVersion, packageName, binaryName)
  if (existsSync(cachePath)) {
    return cachePath
  }
  return null
}

/** Get the SDK version from installed package.json. */
function getSdkVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(require.resolve('@anthropic-ai/claude-agent-sdk/package.json'), 'utf8'))
    return pkg.version as string
  } catch {
    throw new Error('could not determine SDK version')
  }
}

/** Read npm registry metadata for the platform package. */
async function getNpmMetadata(packageName: string, version: string): Promise<{ tarball: string; integrity: string }> {
  const url = `https://registry.npmjs.org/${packageName}/${version}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${packageName}@${version}`)
  }
  const data = (await res.json()) as { dist?: { tarball?: string; integrity?: string } }
  const tarball = data.dist?.tarball
  const integrity = data.dist?.integrity
  if (!tarball || !integrity) {
    throw new Error(`npm registry missing tarball or integrity for ${packageName}@${version}`)
  }
  return { tarball, integrity }
}

/** Download and verify the tarball, extract the binary. */
async function downloadAndExtract(
  home: string,
  sdkVersion: string,
  packageName: string,
): Promise<string> {
  const metadata = await getNpmMetadata(packageName, sdkVersion)
  const binaryName = getBinaryName()
  const cacheDir = join(home, 'claude-code', sdkVersion, packageName)
  mkdirSync(cacheDir, { recursive: true })

  const tempFile = join(cacheDir, `${binaryName}.tmp`)
  const finalPath = join(cacheDir, binaryName)

  // Download tarball
  const tarRes = await fetch(metadata.tarball)
  if (!tarRes.ok) {
    throw new Error(`failed to download ${packageName} from ${metadata.tarball}: ${tarRes.status}`)
  }

  // Verify and stream to temp file
  const hasher = createHash('sha512')
  const writeStream = createWriteStream(tempFile)

  if (!tarRes.body) {
    throw new Error('no response body for tarball download')
  }

  // Collect tarball data for hash verification
  const tarballData = await tarRes.arrayBuffer()
  const tarballBuffer = Buffer.from(tarballData)

  // Hash and verify
  hasher.update(tarballBuffer)
  const digest = hasher.digest('base64')
  const expected = metadata.integrity.replace('sha512-', '')
  if (digest !== expected) {
    unlinkSync(tempFile)
    throw new Error(
      `integrity mismatch for ${packageName}: expected ${expected}, got ${digest}`
    )
  }

  // Write to temp file
  await new Promise<void>((resolve, reject) => {
    writeStream.on('finish', resolve)
    writeStream.on('error', reject)
    writeStream.end(tarballBuffer)
  })

  // Verify sha512 done above, extract binary from tarball
  await extractBinaryFromTar(tarballBuffer, binaryName, finalPath)

  // Remove temp file if extraction succeeded
  if (existsSync(tempFile)) {
    unlinkSync(tempFile)
  }

  // chmod +x on non-Windows
  if (process.platform !== 'win32') {
    const fs = require('node:fs')
    fs.chmodSync(finalPath, 0o755)
  }

  return finalPath
}

/** Extract binary from tar.gz stream. */
async function extractBinaryFromTar(tarballBuffer: Buffer, binaryName: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const targetPath = `package/${binaryName}`
    let found = false

    const inflate = createInflateRaw()
    const chunks: Buffer[] = []

    // Decompress
    inflate.on('data', (chunk) => {
      chunks.push(chunk)
    })
    inflate.on('end', () => {
      const tar = Buffer.concat(chunks)
      extractFromUncompressed(tar, targetPath, outputPath)
        .then(() => {
          found = true
          resolve()
        })
        .catch(reject)
    })
    inflate.on('error', reject)
    inflate.write(tarballBuffer)
    inflate.end()
  })
}

/** Extract a file from uncompressed tar. */
async function extractFromUncompressed(tar: Buffer, targetPath: string, outputPath: string): Promise<void> {
  let offset = 0

  while (offset < tar.length) {
    const headerBuf = tar.subarray(offset, offset + 512)
    if (headerBuf.every((b) => b === 0)) break

    const name = headerBuf.subarray(0, 100).toString('utf8').split('\0')[0]
    const sizeStr = headerBuf.subarray(124, 136).toString('utf8').trim()
    const size = parseInt(sizeStr, 8)

    offset += 512

    if (name === targetPath) {
      const fileData = tar.subarray(offset, offset + size)
      const dir = outputPath.substring(0, outputPath.lastIndexOf('/'))
      mkdirSync(dir, { recursive: true })

      await new Promise<void>((resolve, reject) => {
        const ws = createWriteStream(outputPath)
        ws.on('finish', resolve)
        ws.on('error', reject)
        ws.end(fileData)
      })
      return
    }

    offset += Math.ceil(size / 512) * 512
  }

  throw new Error(`binary ${targetPath} not found in tarball`)
}

/** Try to resolve the binary path synchronously (installed or cached). Returns null if download is needed. */
export function tryResolveClaudeCodeBinary(home: string = join(homedir(), '.hydra-desk-2')): string | null {
  try {
    const installed = checkInstalledPackage()
    if (installed) {
      return installed.binaryPath
    }

    const sdkVersion = getSdkVersion()
    const cached = checkCachedCopy(home, sdkVersion)
    if (cached) {
      return cached
    }
  } catch {
    // If SDK version check fails, we can't proceed
  }

  return null
}

/** Resolve the binary path: installed package > cached copy > download. */
export async function resolveClaudeCodeBinary(home: string = join(homedir(), '.hydra-desk-2')): Promise<string> {
  // Check if installed
  const installed = checkInstalledPackage()
  if (installed) {
    return installed.binaryPath
  }

  const sdkVersion = getSdkVersion()
  const packageName = getPlatformPackageName()

  // Check cache
  const cached = checkCachedCopy(home, sdkVersion)
  if (cached) {
    return cached
  }

  // Download with serialization
  if (!downloadInProgress) {
    downloadInProgress = downloadAndExtract(home, sdkVersion, packageName).then(
      (path) => {
        downloadInProgress = null
        downloadError = null
        return path
      },
      (err) => {
        downloadInProgress = null
        downloadError = err instanceof Error ? err : new Error(String(err))
        throw downloadError
      }
    )
  }

  return downloadInProgress
}

/** Status check without downloading. */
export function getClaudeCodeBinaryStatus(
  home: string = join(homedir(), '.hydra-desk-2')
): { source: 'package' | 'cache' | 'download-needed'; version: string; path?: string } {
  const installed = checkInstalledPackage()
  if (installed) {
    return { source: 'package', version: getSdkVersion(), path: installed.binaryPath }
  }

  const sdkVersion = getSdkVersion()
  const packageName = getPlatformPackageName()
  const cached = checkCachedCopy(home, sdkVersion)

  if (cached) {
    return { source: 'cache', version: sdkVersion, path: cached }
  }

  return { source: 'download-needed', version: sdkVersion }
}
