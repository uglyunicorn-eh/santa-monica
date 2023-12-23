const {
  sentryWebpackPlugin
} = require("@sentry/webpack-plugin");

const path = require('path')

var PACKAGE = require('./package.json');

module.exports = {
  entry: './src/lambda.ts',
  target: 'node',
  mode: 'production',
  devtool: "source-map",

  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: 'ts-loader',
        exclude: /node_modules/,
      },
    ],
  },

  resolve: {
    extensions: ['.tsx', '.ts', '.js'],
    alias: {
      src: path.resolve(__dirname, 'src'),
      "package.json": path.resolve(__dirname, 'package.json'),
    }
  },

  output: {
    path: path.join(__dirname, 'dist'),
    filename: '[name].js',
    libraryTarget: 'commonjs2'
  },

  plugins: [sentryWebpackPlugin({
    authToken: process.env.SENTRY_AUTH_TOKEN,
    org: "uglyunicorn",
    project: "santa-monica",
    release: {
      name: `${PACKAGE.name}@${PACKAGE.version}`,
    },
  })]
}
