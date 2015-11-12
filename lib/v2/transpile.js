var fs = require('fs'),
    path = require('path'),
    autoprefixer = require('autoprefixer'),
    postcss = require('postcss'),
    colors = require('colors'),
    archiver = require('archiver'),
    ConfigXml = require('../config-xml'),
    logging = require('../logging'),
    Multibar = require('../multibar'),
    path = require('path'),
    Q = require('q'),
    sass = require('node-sass'),
    shelljs = require('shelljs'),
    vinylFs = require('vinyl-fs'),
    webpack = require('webpack');

var Transpile = module.exports;

Transpile.autoprefixerOpts = {
  browsers: [
    'last 2 versions',
    'iOS >= 7',
    'Android >= 4',
    'Explorer >= 10',
    'ExplorerMobile >= 11'
  ],
  cascade: false
};

Transpile.webpackConfigForPath = function webpackConfigForPath(appDirectory) {
  var defaultConfig = {
    entry: [
      "es6-shim",
      "zone.js",
      "reflect-metadata",
      "web-animations.min",
      "./www/app/app.js" // your app entry
    ],
    output: {
      path: path.join(appDirectory, 'www', 'build', 'js'),
      filename: 'app.bundle.js',
      //pathinfo: true // show module paths in the bundle, handy for debugging
    },
    postcss: [ autoprefixer(Transpile.autoprefixerOpts) ],
    module: {
      loaders: [
        {
          test: /\.js$/,
          loader: "awesome-typescript-loader?doTypeCheck=false&useWebpackText=true",
          include: path.join(appDirectory, 'www', 'app')
        },
        {
          test: /\.ts$/,
          loader: "awesome-typescript-loader",
          include: path.join(appDirectory, 'www', 'app')
        },
        {
          test: /\.scss$/,
          loader: "style!css!sass?outputStyle=expanded"
        },
        {
          test: /\.css$/,
          loader: "style-loader!css-loader!postcss-loader"
        }
      ]
    },
    resolve: {
      modulesDirectories: [
        "node_modules",
        "node_modules/ionic-framework/node_modules", // angular is a dependency of ionic
        "node_modules/ionic-framework/dist/src/es5/common", // ionic-framework npm package (stable)
        "node_modules/ionic-framework/dist/js" // for web-animations polyfill
      ],
      extensions: ["", ".js", ".ts"]
    }
  };

  return defaultConfig;
};

Transpile.compile = function compile(appDirectory, watch, cb, options) {
  var Serve = require('./serve');
  var q = Q.defer();

  // prevent gulp calling done callback more than once when watching
  var firstTime = true;

  // load webpack config
  var config,
      webPackConfigPath = path.join(appDirectory, 'webpack.config.js');

  logging.logger.info('∆ Compiling and bundling with Webpack...\n'.yellow.bold);

  try {
    config = require(webPackConfigPath);
    logging.logger.info(['√ Using your webpack.config.js file:', webPackConfigPath, ''].join(' ').green.bold);
  } catch (ex) {
    //No config existed. Use default;
    logging.logger.info('√ Using default Ionic webpack.config settings.'.green.bold);
    config = Transpile.webpackConfigForPath(appDirectory);
  }

  logging.logger.verbose('compile config:', config);

  // https://github.com/webpack/docs/wiki/node.js-api#statstojsonoptions
  var statsOptions = {
    'colors': true,
    'modules': true,
    'chunks': false,
    'exclude': ['node_modules']
  }

  // use Ionic CLI's loaders so we don't have to install them in every project
  if (config.resolveLoader && config.resolveLoader.modulesDirectories) {
    config.resolveLoader.modulesDirectories.concat(path.normalize(__dirname + '../../../node_modules'));
  } else {
    config.resolveLoader = {
      modulesDirectories: ["node_modules", path.normalize(__dirname + '../../../node_modules')]
    }
  }


  var compiler = webpack(config);
  if (watch) {
    //TODO expose watch options
    compiler.watch(null, compileHandler);
  } else {
    compiler.run(compileHandler);
  }

  function compileHandler(err, stats){
    if (firstTime) {
      firstTime = false;
      cb();
    } else {
      var bundleFile = path.resolve(path.join(compiler.options.output.path,
                             compiler.options.output.filename));
      Serve._postToLiveReload(bundleFile, options)
    }

    var jsonStats = stats.toJson();

    if(err) {
      return q.reject(err);
    }

    if (jsonStats.errors.length > 0) {
      logging.logger.info('There were some errors with webpack'.error);
      logging.logger.info(jsonStats.errors.toString().error);
      return q.reject(jsonStats.errors);
    }

    if (jsonStats.warnings.length > 0) {
      logging.logger.debug('There are some warnings');
      logging.logger.debug(jsonStats.warnings);
    }

    // return q.resolve(stats.toString(statsOptions))
    // print build stats and errors
    // logging.logger.info(stats.toString(statsOptions));
    // logging.logger.info('There were some issues');
    // logging.logger.info(stats.toString(statsOptions));
    // q.resolve(stats.toString(statsOptions));
    return q.resolve(stats.toString(statsOptions));
  }

  return q.promise;
};


Transpile.processSass = function processSass(appDirectory, entryFile, includePaths, outputFile) {
  if (!entryFile || !includePaths || !outputFile) {
    throw "Missing argument to processSass";
  }

  var q = Q.defer();
  logging.logger.debug('Process sass appDirectory', appDirectory);
  logging.logger.debug('Process sass entryPath', entryFile);
  logging.logger.debug('Process sass includePaths', includePaths);
  logging.logger.debug('Process sass entryPath', outputFile);

  Transpile.checkBuildDirectories(appDirectory);

  var autoprefixerOpts = {
    browsers: [
      'last 2 versions',
      'iOS >= 7',
      'Android >= 4',
      'Explorer >= 10',
      'ExplorerMobile >= 11'
    ],
    cascade: false
  };

  logging.logger.info('∆ Compiling your SASS to CSS.'.yellow.bold);
  var resolvedEntryFile = path.resolve(path.join(appDirectory, entryFile));
  var resolvedIncludePaths = includePaths.map(function(includePath){
    return path.resolve(path.join(appDirectory, includePath))
  });
  var resolvedOutputPath = path.resolve(path.join(appDirectory, outputFile));

  var sassOutput = sass.renderSync({file: resolvedEntryFile, includePaths: resolvedIncludePaths});
  logging.logger.info('√ Sass compiled to CSS.'.green.bold);
  // logging.logger.debug('Sass output:', sassOutput.css.toString());

  var prefixerOutput = autoprefixer(autoprefixerOpts);

  logging.logger.info('∆ Running postcss and autoprefixer on compiled CSS.'.yellow.bold);

  var cssPromise = postcss([ prefixerOutput ]).process(sassOutput.css.toString())
  .then(function (result) {
    // logging.logger.info('√ Compiling CSS completed.'.green.bold);

    if (result.warnings()) {
      logging.logger.debug('There are some warnings with your build:'.yellow.bold);
    }

    result.warnings().forEach(function (warn) {
      logging.logger.debug(warn.toString());
    });

    // logging.logger.debug('Css result:', result.css);

    logging.logger.info(['√ CSS processed to:', outputFile, ''].join(' ').green.bold);

    try {
      fs.writeFileSync(resolvedOutputPath, result.css);
      return resolvedOutputPath;
    } catch(ex) {
      console.log('ex', ex);
    }
  }).catch(function(err){
    logging.logger.error(err);
  });

  // logging.logger.info('√ CSS compilation completed.'.green.bold);

  return cssPromise;
};

Transpile.prepareFonts = function prepareFonts(appDirectory, fontsOutputPath) {
  logging.logger.debug('∆ Preparing fonts.'.yellow.bold);
  var ionicFrameworkFontPath = path.join(appDirectory, 'node_modules', 'ionic-framework', 'dist', 'fonts'),
      tffFontPath = path.join(ionicFrameworkFontPath, '*.ttf'),
      woffFontPath = path.join(ionicFrameworkFontPath, '*.woff'),
      pathsToCopy = [tffFontPath, woffFontPath];

  logging.logger.debug('Fonts to copy:', pathsToCopy);

  vinylFs.src(pathsToCopy)
  .pipe(vinylFs.dest(path.resolve(path.join(appDirectory, fontsOutputPath))));

  logging.logger.debug('√ Fonts completed.'.green.bold);
}

Transpile.checkBuildDirectories = function checkBuildDirectories(appDirectory) {
  var buildPath = path.join(appDirectory, 'www', 'build');
  var cssBuildPath = path.join(buildPath, 'css');
  var fontBuildPath = path.join(buildPath, 'fonts');

  var paths = [buildPath, cssBuildPath, fontBuildPath];

  paths.forEach(function(pathToMk) {
    if (!fs.existsSync(pathToMk)) {
      fs.mkdirSync(pathToMk);
    }
  })

  // if (!fs.existsSync(buildPath)) {
  //   fs.mkdirSync(buildPath);
  // }

  // if (!fs.existsSync(cssBuildPath)) {
  //   fs.mkdirSync(cssBuildPath);
  // }
};