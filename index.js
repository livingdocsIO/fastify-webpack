const fs = require('fs')
const path = require('path')
const fp = require('fastify-plugin')
const fastifyStatic = require('fastify-static')
const fnv1a = require('fastify-etag/fnv1a')
function generateETag (payload) { return `"${fnv1a(payload).toString(36)}"` }

async function webpackPlugin (fastify, options) {
  const distDir = options.distDir ? path.resolve(options.distDir) : path.resolve('./dist')
  // support a prefix `/` which would result in `///assets`
  // we can't use path.join here because we want to be cross-platform compatible
  // and this is a url, not a file system path
  const publicPath = `/${options.prefix}/assets`.replace(/\/\/\/?/g, '/')

  let assetsMap
  if (!options.watch) {
    try {
      const assetsMapPath = path.join(distDir, '.assets.json')
      const assetsMapContent = fs.readFileSync(assetsMapPath, 'utf8')
      assetsMap = JSON.parse(assetsMapContent)
      fastify.decorate('assets', assetsMap)
    } catch (err) {
      fastify.log.error({err}, `Assets weren't built yet, stopping server.`)
      process.exit(1)
      return
    }
  }

  if (options.compress) fastify.register(require('fastify-compress'))

  let fastifyStaticInitialized = false
  fastify.addHook('onRoute', (route) => {
    if (fastifyStaticInitialized) return
    if (route.path.startsWith(publicPath)) {
      route.config = {...route.config, static: !options.watch}
    }
  })

  fastify.register(fastifyStatic, {
    root: distDir,
    prefix: publicPath,
    wildcard: options.watch,
    maxAge: options.watch ? undefined : options.maxAge,
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
      if (!rep.context.config.static) return done()

      const etag = etagCache.get(req.req.url)
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

      if (rep.context.config.static && !rep[ETagCached]) etagCache.set(req.req.url, etag)
      if (req.headers['if-none-match'] === etag) rep.code(304)
      done()
    })
  })

  const publicAssetPath = (pathname) => {
    if (!options.cdnUrl) return pathname
    // make sure that the cdnUrl has always a postfix `/`
    return `${options.cdnUrl.replace(/\/?$/, '/') || ''}${pathname.replace('assets/', '')}`
  }

  function toAssetPath (asset) {
    const all = []
    const name = asset.name

    if (asset.type === 'style') {
      const file = assetsMap[`${name}.scss`] || assetsMap[`${name}.css`] || assetsMap[`${name}.js`] || {} // eslint-disable-line max-len
      if (/\.css$/.test(file.src)) all.push({type: 'style', href: publicAssetPath(file.src)})
      else if (/\.js$/.test(file.src)) all.push({type: 'script', href: publicAssetPath(file.src)})
      else fastify.log.warn('Style asset to embed not found', name)
    } else if (asset.type === 'script') {
      const file = assetsMap[`${name}.js`]
      if (file) all.push({type: 'script', href: publicAssetPath(file.src)})
      else fastify.log.warn(`Script asset to embed not found '${name}'`)
    } else if (asset.type === 'favicon') {
      const file = assetsMap[`${name}.ico`]
      if (file) all.push({type: 'favicon', href: publicAssetPath(file.src)})
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

  if (options.watch) {
    const webpackConfig = options.webpackConfig || require(path.resolve('./webpack.config'))
    fastify.register(module.parent.require('fastify-webpack-hmr'), {
      config: webpackConfig,
      webpackDev: {
        watchOptions: {
          ignored: [distDir]
        },
        ...options.webpackDev,
        publicPath
      }
    }).after((err) => {
      if (err) throw err

      const compiled = new Promise((resolve, reject) => {
        fastify.webpack.compiler.hooks.afterEmit.tap('WebpackDevMiddleware', (compilation) => {
          if (!assetsMap) resolve()

          const newAssetsMap = JSON.parse(compilation.assets['.assets.json']._value)
          if (!assetsMap) {
            assetsMap = newAssetsMap
            fastify.decorate('assets', assetsMap)
          } else {
            for (const key in assetsMap) delete assetsMap[key]
            Object.assign(assetsMap, newAssetsMap)
          }
        })
      })

      fastify.use((req, reply, next) => {
        if (assetsMap) return next()
        compiled.then(() => next())
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
    let html = !options.watch && toHtml(app)
    return {
      config: {static: true},
      handler (request, reply) {
        if (options.watch) html = toHtml(app)

        reply
          .header('Link', html.linkHeader)
          .header('Cache-control', 'no-cache')
          .type('text/html')
          .send(html.string)
      }
    }
  }

  function toHtml (app) {
    const assets = (app.assets || []).reduce((a, asset) => [...a, ...toAssetPath(asset)], [])
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
    if (!options.watch) return (req, rep) => rep.sendFile(filename)

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
  fastify: '2.x',
  name: '@livingdocs/fastify-webpack'
})

let cachedClass
plugin.assetManifest = function getAssetManifestClass (opts) {
  return new plugin.AssetManifest(opts)
}

Object.defineProperty(plugin, 'AssetManifest', {
  get () {
    if (cachedClass) return cachedClass
    const UpstreamAssetManifestPlugin = module.parent.require('webpack-assets-manifest')
    class AssetManifestPlugin {
      constructor (opts) {
        this.options = opts || {}
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
