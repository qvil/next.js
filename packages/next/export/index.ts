import chalk from 'chalk'
import findUp from 'find-up'
import {
  copyFile as copyFileOrig,
  existsSync,
  mkdir as mkdirOrig,
  readFileSync,
  writeFileSync,
} from 'fs'
import Worker from 'jest-worker'
import { cpus } from 'os'
import { dirname, join, resolve, sep } from 'path'
import { promisify } from 'util'
import { AmpPageStatus, formatAmpMessages } from '../build/output/index'
import createSpinner from '../build/spinner'
import { API_ROUTE } from '../lib/constants'
import { recursiveCopy } from '../lib/recursive-copy'
import { recursiveDelete } from '../lib/recursive-delete'
import {
  BUILD_ID_FILE,
  CLIENT_PUBLIC_FILES_PATH,
  CLIENT_STATIC_FILES_PATH,
  CONFIG_FILE,
  EXPORT_DETAIL,
  PAGES_MANIFEST,
  PHASE_EXPORT,
  PRERENDER_MANIFEST,
  SERVERLESS_DIRECTORY,
  SERVER_DIRECTORY,
} from '../next-server/lib/constants'
import loadConfig, {
  isTargetLikeServerless,
} from '../next-server/server/config'
import { eventCliSession } from '../telemetry/events'
import { Telemetry } from '../telemetry/storage'
import { normalizePagePath } from '../next-server/server/normalize-page-path'

const copyFile = promisify(copyFileOrig)
const mkdir = promisify(mkdirOrig)

const createProgress = (total: number, label = 'Exporting') => {
  let curProgress = 0
  let progressSpinner = createSpinner(`${label} (${curProgress}/${total})`, {
    spinner: {
      frames: [
        '[    ]',
        '[=   ]',
        '[==  ]',
        '[=== ]',
        '[ ===]',
        '[  ==]',
        '[   =]',
        '[    ]',
        '[   =]',
        '[  ==]',
        '[ ===]',
        '[====]',
        '[=== ]',
        '[==  ]',
        '[=   ]',
      ],
      interval: 80,
    },
  })

  return () => {
    curProgress++

    const newText = `${label} (${curProgress}/${total})`
    if (progressSpinner) {
      progressSpinner.text = newText
    } else {
      console.log(newText)
    }

    if (curProgress === total && progressSpinner) {
      progressSpinner.stop()
      console.log(newText)
    }
  }
}

type ExportPathMap = {
  [page: string]: { page: string; query?: { [key: string]: string } }
}

export default async function(
  dir: string,
  options: any,
  configuration?: any
): Promise<void> {
  function log(message: string) {
    if (options.silent) {
      return
    }
    console.log(message)
  }

  dir = resolve(dir)
  const nextConfig = configuration || loadConfig(PHASE_EXPORT, dir)
  const threads = options.threads || Math.max(cpus().length - 1, 1)
  const distDir = join(dir, nextConfig.distDir)

  const telemetry = options.buildExport ? null : new Telemetry({ distDir })

  if (telemetry) {
    telemetry.record(
      eventCliSession(PHASE_EXPORT, distDir, {
        cliCommand: 'export',
        isSrcDir: null,
        hasNowJson: !!(await findUp('now.json', { cwd: dir })),
        isCustomServer: null,
      })
    )
  }

  const subFolders = nextConfig.exportTrailingSlash
  const isLikeServerless = nextConfig.target !== 'server'

  log(`> using build directory: ${distDir}`)

  if (!existsSync(distDir)) {
    throw new Error(
      `Build directory ${distDir} does not exist. Make sure you run "next build" before running "next start" or "next export".`
    )
  }

  const buildId = readFileSync(join(distDir, BUILD_ID_FILE), 'utf8')
  const pagesManifest =
    !options.pages &&
    require(join(
      distDir,
      isLikeServerless ? SERVERLESS_DIRECTORY : SERVER_DIRECTORY,
      PAGES_MANIFEST
    ))

  let prerenderManifest
  try {
    prerenderManifest = require(join(distDir, PRERENDER_MANIFEST))
  } catch (_) {}

  const distPagesDir = join(
    distDir,
    isLikeServerless
      ? SERVERLESS_DIRECTORY
      : join(SERVER_DIRECTORY, 'static', buildId),
    'pages'
  )

  const pages = options.pages || Object.keys(pagesManifest)
  const defaultPathMap: ExportPathMap = {}

  for (const page of pages) {
    // _document and _app are not real pages
    // _error is exported as 404.html later on
    // API Routes are Node.js functions
    if (
      page === '/_document' ||
      page === '/_app' ||
      page === '/_error' ||
      page.match(API_ROUTE)
    ) {
      continue
    }

    // iSSG pages that are dynamic should not export templated version by
    // default. In most cases, this would never work. There is no server that
    // could run `getStaticProps`. If users make their page work lazily, they
    // can manually add it to the `exportPathMap`.
    if (prerenderManifest?.dynamicRoutes[page]) {
      continue
    }

    defaultPathMap[page] = { page }
  }

  // Initialize the output directory
  const outDir = options.outdir

  if (outDir === join(dir, 'public')) {
    throw new Error(
      `The 'public' directory is reserved in Next.js and can not be used as the export out directory. https://err.sh/zeit/next.js/can-not-output-to-public`
    )
  }

  await recursiveDelete(join(outDir))
  await mkdir(join(outDir, '_next', buildId), { recursive: true })

  writeFileSync(
    join(distDir, EXPORT_DETAIL),
    JSON.stringify({
      version: 1,
      outDirectory: outDir,
      success: false,
    }),
    'utf8'
  )

  // Copy static directory
  if (!options.buildExport && existsSync(join(dir, 'static'))) {
    log('  copying "static" directory')
    await recursiveCopy(join(dir, 'static'), join(outDir, 'static'))
  }

  // Copy .next/static directory
  if (existsSync(join(distDir, CLIENT_STATIC_FILES_PATH))) {
    log('  copying "static build" directory')
    await recursiveCopy(
      join(distDir, CLIENT_STATIC_FILES_PATH),
      join(outDir, '_next', CLIENT_STATIC_FILES_PATH)
    )
  }

  // Get the exportPathMap from the config file
  if (typeof nextConfig.exportPathMap !== 'function') {
    console.log(
      `> No "exportPathMap" found in "${CONFIG_FILE}". Generating map from "./pages"`
    )
    nextConfig.exportPathMap = async (defaultMap: ExportPathMap) => {
      return defaultMap
    }
  }

  // Start the rendering process
  const renderOpts = {
    dir,
    buildId,
    nextExport: true,
    assetPrefix: nextConfig.assetPrefix.replace(/\/$/, ''),
    distDir,
    dev: false,
    staticMarkup: false,
    hotReloader: null,
    canonicalBase: nextConfig.amp?.canonicalBase || '',
    isModern: nextConfig.experimental.modern,
    ampValidatorPath: nextConfig.experimental.amp?.validator || undefined,
    ampSkipValidation: nextConfig.experimental.amp?.skipValidation || false,
    ampOptimizerConfig: nextConfig.experimental.amp?.optimizer || undefined,
  }

  const { serverRuntimeConfig, publicRuntimeConfig } = nextConfig

  if (Object.keys(publicRuntimeConfig).length > 0) {
    ;(renderOpts as any).runtimeConfig = publicRuntimeConfig
  }

  // We need this for server rendering the Link component.
  ;(global as any).__NEXT_DATA__ = {
    nextExport: true,
  }

  log(`  launching ${threads} workers`)
  const exportPathMap = await nextConfig.exportPathMap(defaultPathMap, {
    dev: false,
    dir,
    outDir,
    distDir,
    buildId,
  })
  if (!exportPathMap['/404'] && !exportPathMap['/404.html']) {
    exportPathMap['/404'] = exportPathMap['/404.html'] = {
      page: '/_error',
    }
  }
  const exportPaths = Object.keys(exportPathMap)
  const filteredPaths = exportPaths.filter(
    // Remove API routes
    route => !exportPathMap[route].page.match(API_ROUTE)
  )
  const hasApiRoutes = exportPaths.length !== filteredPaths.length

  // Warn if the user defines a path for an API page
  if (hasApiRoutes) {
    log(
      chalk.yellow(
        '  API pages are not supported by next export. https://err.sh/zeit/next.js/api-routes-static-export'
      )
    )
  }

  const progress = !options.silent && createProgress(filteredPaths.length)
  const pagesDataDir = options.buildExport
    ? outDir
    : join(outDir, '_next/data', buildId)

  const ampValidations: AmpPageStatus = {}
  let hadValidationError = false

  const publicDir = join(dir, CLIENT_PUBLIC_FILES_PATH)
  // Copy public directory
  if (!options.buildExport && existsSync(publicDir)) {
    log('  copying "public" directory')
    await recursiveCopy(publicDir, outDir, {
      filter(path) {
        // Exclude paths used by pages
        return !exportPathMap[path]
      },
    })
  }

  const worker: Worker & { default: Function } = new Worker(
    require.resolve('./worker'),
    {
      maxRetries: 0,
      numWorkers: threads,
      enableWorkerThreads: nextConfig.experimental.workerThreads,
      exposedMethods: ['default'],
    }
  ) as any

  worker.getStdout().pipe(process.stdout)
  worker.getStderr().pipe(process.stderr)

  let renderError = false

  await Promise.all(
    filteredPaths.map(async path => {
      const result = await worker.default({
        path,
        pathMap: exportPathMap[path],
        distDir,
        buildId,
        outDir,
        pagesDataDir,
        renderOpts,
        serverRuntimeConfig,
        subFolders,
        buildExport: options.buildExport,
        serverless: isTargetLikeServerless(nextConfig.target),
      })

      for (const validation of result.ampValidations || []) {
        const { page, result } = validation
        ampValidations[page] = result
        hadValidationError =
          hadValidationError ||
          (Array.isArray(result?.errors) && result.errors.length > 0)
      }
      renderError = renderError || !!result.error

      if (
        options.buildExport &&
        typeof result.fromBuildExportRevalidate !== 'undefined'
      ) {
        configuration.initialPageRevalidationMap[path] =
          result.fromBuildExportRevalidate
      }
      if (progress) progress()
    })
  )

  worker.end()

  // copy prerendered routes to outDir
  if (!options.buildExport && prerenderManifest) {
    await Promise.all(
      Object.keys(prerenderManifest.routes).map(async route => {
        route = normalizePagePath(route)
        const orig = join(distPagesDir, route)
        const htmlDest = join(
          outDir,
          `${route}${
            subFolders && route !== '/index' ? `${sep}index` : ''
          }.html`
        )
        const jsonDest = join(pagesDataDir, `${route}.json`)

        await mkdir(dirname(htmlDest), { recursive: true })
        await mkdir(dirname(jsonDest), { recursive: true })
        await copyFile(`${orig}.html`, htmlDest)
        await copyFile(`${orig}.json`, jsonDest)
      })
    )
  }

  if (Object.keys(ampValidations).length) {
    console.log(formatAmpMessages(ampValidations))
  }
  if (hadValidationError) {
    throw new Error(
      `AMP Validation caused the export to fail. https://err.sh/zeit/next.js/amp-export-validation`
    )
  }

  if (renderError) {
    throw new Error(`Export encountered errors`)
  }
  // Add an empty line to the console for the better readability.
  log('')

  writeFileSync(
    join(distDir, EXPORT_DETAIL),
    JSON.stringify({
      version: 1,
      outDirectory: outDir,
      success: true,
    }),
    'utf8'
  )

  if (telemetry) {
    await telemetry.flush()
  }
}
