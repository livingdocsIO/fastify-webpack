const fs = require('fs')
const path = require('path')
const fp = require('fastify-plugin')
const fastifyStatic = require('@fastify/static')
const fnv1a = require('./fnv1a')
function generateETag (payload) { return `"${fnv1a(payload).toString(36)}"` }

function strip (str, leading, trailing) {
  return str
    .replace(/\/+/g, '/')
    .replace(/^\/*/, leading ? '/' : '')
    .replace(/\/*$/, trailing ? '/' : '')
}

async function webpackPlugin (fastify, opts) {
  const distDir = opts.distDir
    ? path.resolve(opts.distDir)
    : path.resolve('./dist')

  // support a prefix `/` which would result in `///assets`
  // we can't use path.join here because we want to be cross-platform compatible
  // and this is a url, not a file system path
  const publicAssetsPath = strip(`${opts.prefix}/assets`, true)
  const defaultCdnUrl = opts.cdnUrl
    ? opts.cdnUrl.replace(/\/?$/, '/')
    : strip(opts.prefix, true, true)

  const assetsMap = {}
  fastify.decorate('assets', assetsMap)

  if (!opts.watch) {
    try {
      const assetsMapPath = path.join(distDir, '.assets.json')
      const assetsMapContent = JSON.parse(fs.readFileSync(assetsMapPath, 'utf8'))
      for (const key in assetsMap) delete assetsMap[key]
      Object.assign(assetsMap, assetsMapContent)
    } catch (err) {
      fastify.log.error({err}, `Assets weren't built yet, stopping server.`)
      process.exit(1)
      return
    }
  }

  if (opts.compress) fastify.register(require('@fastify/compress'))

  let fastifyStaticInitialized = false
  fastify.addHook('onRoute', (route) => {
    if (fastifyStaticInitialized) return
    if (route.path.startsWith(publicAssetsPath)) {
      route.config = {...route.config, static: !opts.watch}
    }
  })

  fastify.register(fastifyStatic, {
    root: distDir,
    prefix: publicAssetsPath,
    wildcard: opts.watch,
    maxAge: opts.watch ? undefined : opts.maxAge,
    etag: true,
    lastModified: false,
    acceptRanges: false
  }).after((err) => {
    if (err) throw err
    fastifyStaticInitialized = true

    const etagCache = new Map()
    const ETagCached = Symbol('ETagCached')
    const ETagMatched = Symbol('ETagMatched')
    fastify.addHook('onRequest', (req, rep, done) => {
      if (!req.routeOptions.config.static) return done()

      req.cdnUrl = req.headers['x-cdn-url'] || defaultCdnUrl
      const etag = etagCache.get(`${req.cdnUrl}${req.raw.url}`)
      if (!etag) return done()

      rep[ETagCached] = etag
      rep.header('ETag', etag)

      if (req.headers['if-none-match'] === etag) {
        rep[ETagMatched] = etag
        return rep.code(304).send('')
      }
      done()
    })

    fastify.addHook('onSend', (req, rep, payload, done) => {
      if (rep[ETagMatched]) return done()

      let etag = rep.getHeader('ETag')
      if (!etag) {
        if (!payload || !(typeof payload === 'string' || payload instanceof Buffer)) return done()
        etag = generateETag(payload)
        rep.header('ETag', etag)
      }

      if (req.routeOptions.config.static && !rep[ETagCached]) {
        etagCache.set(`${req.cdnUrl}${req.raw.url}`, etag)
      }
      if (req.headers['if-none-match'] === etag) rep.code(304)
      done()
    })
  })

  function toAssetPath (asset, cdnUrl) {
    const all = []
    const name = asset.name

    if (asset.type === 'style') {
      const file = assetsMap[`${name}.scss`] ||
        assetsMap[`${name}.css`] ||
        assetsMap[`${name}.js`] ||
        {}

      if (/\.css$/.test(file.src)) all.push({type: 'style', href: `${cdnUrl}${file.src}`})
      else if (/\.js$/.test(file.src)) all.push({type: 'script', href: `${cdnUrl}${file.src}`})
      else fastify.log.warn('Style asset to embed not found', name)
    } else if (asset.type === 'script') {
      const file = assetsMap[`${name}.js`]
      if (file) all.push({type: 'script', href: `${cdnUrl}${file.src}`})
      else fastify.log.warn(`Script asset to embed not found '${name}'`)
    } else if (asset.type === 'favicon') {
      const file = assetsMap[`${name}.ico`]
      if (file) all.push({type: 'favicon', href: `${cdnUrl}${file.src}`})
      else fastify.log.warn(`Favicon to embed not found '${name}'`)
    }

    if (!all.length) fastify.log.warn('Asset to embed not found', name)
    return all
  }

  function toAssets (assets) {
    return assets.map(({type, href}) => {
      if (type === 'favicon') return `<link rel="icon" href="${href}">`
      if (type === 'script') return `<script src="${href}"></script>`
      if (type === 'style') return `<link rel="stylesheet" href="${href}">`
    })
  }

  if (opts.watch) {
    let compiledPromise = new Promise((resolve) => {
      fastify.addHook('onRequest', (req, rep, next) => {
        if (!compiledPromise) return next()
        compiledPromise.then(() => next())
      })

      const webpackHot = opts.webpackHot
      const webpackConfig = opts.webpackConfig || require(path.resolve('./webpack.config'))
      const extendedWebpackConfig = {
        ...webpackConfig,
        watchOptions: {
          ignored: [distDir]
        }
      }

      fastify.register(module.parent.require('fastify-webpack-hmr'), {
        compiler: opts.webpack ? opts.webpack(extendedWebpackConfig) : undefined,
        config: opts.webpack ? undefined : extendedWebpackConfig,
        webpackDev: {
          ...opts.webpackDev,
          publicPath: publicAssetsPath
        },
        webpackHot
      }).after((err) => {
        if (err) throw err
        fastify.webpack.compiler.hooks.assetEmitted
          .tap('FastifyWebpackPlugin', (filePath, asset) => {
            if (filePath !== '.assets.json') return
            const newAssetsMap = JSON.parse((asset.content).toString('utf8'))
            for (const key in assetsMap) delete assetsMap[key]
            Object.assign(assetsMap, newAssetsMap)
          })

        fastify.webpack.compiler.hooks['afterDone']
          .tap('webpack-dev-middleware', () => {
            if (!compiledPromise) return
            process.nextTick(() => {
              resolve()
              compiledPromise = undefined
            })
          })
      })
    })
  }

  fastify.decorate('webpackHtml', webpackHtml)
  fastify.decorate('webpackAsset', serve)
  fastify.decorate('static', staticWithCache)
  fastify.decorate('staticNoCache', staticNoCache)

  function staticNoCache ({cacheControl, ...additional}) {
    const obj = staticWithCache({...additional, cacheControl: 'no-cache'})
    return obj
  }

  function staticWithCache ({code, body, type, cacheControl, ...additional}) {
    if (!type && typeof body === 'object') type = 'application/json'
    code = code || 200

    return {
      config: {static: true, ...additional},
      handler (req, rep) {
        if (cacheControl) rep.header('Cache-Control', cacheControl)

        rep
          .type(type)
          .code(code)
          .send(body)
      }
    }
  }

  function webpackHtml (app) {
    const htmlByCdnUrl = {}
    return {
      config: {static: true},
      handler (req, reply) {
        let toServe = htmlByCdnUrl[req.cdnUrl]
        if (!toServe) {
          if (opts.watch) {
            toServe = toHtml(app, req.cdnUrl)
          } else {
            toServe = toHtml(app, req.cdnUrl)
            htmlByCdnUrl[req.cdnUrl] = toServe
          }
        }

        reply
          .header('Link', toServe.linkHeader)
          .header('Cache-control', 'no-cache')
          .type('text/html')
          .send(toServe.string)
      }
    }
  }

  function toHtml (app, cdnUrl) {
    const assets = (app.assets || [])
      .reduce((a, asset) => [...a, ...toAssetPath(asset, cdnUrl)], [])

    const links = [...(app.linkHeader || []), ...assets.map(({type, ...all}) => {
      if (type === 'style') return `<${all.href}>; rel=preload; as=style`
      if (type === 'script') return `<${all.href}>; rel=preload; as=script`
    })].filter(Boolean)

    const head = [
      app.base && `<base href="${app.base}">`,
      '<meta charset="utf-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, minimum-scale=1, shrink-to-fit=no">', // eslint-disable-line max-len
      app.title && `<title>${app.title}</title>`,
      app.description && `<meta name="description" content="${app.description || ''}">`,
      ...(app.head || [])
    ].filter(Boolean)

    return {
      linkHeader: links.length && links,
      assets,
      string: `
        <!doctype html>
        <html>
          <head>
            ${head.join('\n            ')}
            ${toAssets(assets).join('\n            ')}
          </head>
          <body>${app.body || ''}</body>
        </html>
      `.split('\n').map((l) => l.replace(/^ {0,8}/, '')).join('\n').trim()
    }
  }

  function serve (filename) {
    if (!opts.watch) return (req, rep) => rep.sendFile(filename)

    let contentType
    if (filename.endsWith('.html')) contentType = 'text/html'
    if (filename.endsWith('.js')) contentType = 'application/javascript'
    if (filename.endsWith('.json')) contentType = 'application/json'
    if (filename.endsWith('.ico')) contentType = 'image/x-icon'
    if (filename.endsWith('.txt')) contentType = 'text/plain'
    if (filename.endsWith('.css')) contentType = 'text/css'

    const filepath = path.join(distDir, filename)
    return function (req, rep) {
      rep
        .header('Content-Type', contentType)
        .send(fastify.webpack.compiler.outputFileSystem.readFileSync(filepath))
    }
  }
}

const plugin = fp(webpackPlugin, {
  fastify: '5.x',
  name: '@livingdocs/fastify-webpack'
})

let cachedClass
plugin.assetManifest = function getAssetManifestClass (options) {
  return new plugin.AssetManifest(options)
}

Object.defineProperty(plugin, 'AssetManifest', {
  get () {
    if (cachedClass) return cachedClass
    const UpstreamAssetManifestPlugin = module.parent.require('webpack-assets-manifest')
    class AssetManifestPlugin {
      constructor (options) {
        this.options = options || {}
      }

      apply (compiler) {
        this.plugin = this.plugin || new UpstreamAssetManifestPlugin({
          publicPath: true,
          output: path.join(compiler.options.output.path, '.assets.json'),
          integrity: this.options.integrity,
          writeToDisk: this.options.writeToDisk,
          customize (entry, original, manifest, asset) {
            return {
              key: entry.key.replace(/\?.*$/, ''),
              value: {
                src: entry.value,
                integrity: asset.integrity
              }
            }
          }

        })

        this.plugin.apply(compiler)
      }
    }

    cachedClass = AssetManifestPlugin
    return cachedClass
  }
})

module.exports = plugin
