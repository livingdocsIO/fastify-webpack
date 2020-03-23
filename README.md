# @livingdocs/fastify-webpack

More details will follow

```
npm install fastify @livingdocs/fastify-webpack
npm install --save-dev fastify-webpack-hmr
```

```js
const fastify = require('fastify')
const fastifyWebpack = require('@livingdocs/fastify-webpack')

const watch = process.argv.slice(2).includes('watch')
const optimized = process.argv.slice(2).includes('optimize')

fastify.register(fastifyWebpack, {
  watch,
  // Force the expiration when `watch` isn't true
  maxAge: '1y',
  // we can define the cdnurl
  cdnUrl: 'https://somecdn.yourproject.com',
  // optional, by default it uses webpack.config.js
  webpackConfig: require('./custom-webpack-config')
})

fastify.get('/', fastify.webpackHtml({
  body: '<h1>Hello</h1>'
}))
```


```js
const fastifyWebpack = require('@livingdocs/fastify-webpack')
module.exports = {
  context: __dirname,
  mode: optimized ? 'production' : 'development',
  stats: false,
  entry: {
    index: './src/index.js'
  },
  output: {
    // make sure that there's no `/` in the front, so all the assets
    // are referenced using relative urls.
    // This allows us to host the files anywhere on any url, even subdirectories
    publicPath: 'assets/',
    filename: optimized ? '[name].[contenthash].js' : '[name].[hash].js',
    chunkFilename: optimized ? '[name].[contenthash].js' : '[name].[hash].js'
  },
  plugins: [new fastifyWebpack.AssetManifestPlugin()]
}
```
