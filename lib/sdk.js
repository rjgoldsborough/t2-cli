var blocks = require('block-stream2');
var bz2 = require('unbzip2-stream');
var createHash = require('sha.js')
var fs = require('fs-extra-promise');
var osenv = require('osenv');
var path = require('path');
var Progress = require('progress');
var Promise = require('bluebird');
var request = require('request');
var spawn = require('child_process').spawn;
var tar = require('tar-fs');
var tmp = require('tmp');
var Transform = require('stream').Transform;
var zlib = require('zlib');

var getPlatform = exports.getPlatform = () => {
  switch (process.platform) {
    case 'darwin': return 'macos';
    case 'linux': return 'linux';
    default:
      throw new Error('Your platform is not yet supported for cross-compilation.');
  }
}

var paths = {
  sdk: path.join(osenv.home(), '.tessel/sdk'),
  rustlib: path.join(osenv.home(), '.tessel/rust/rustlib'),
  rustTarget: path.join(osenv.home(), '.tessel/rust/tessel2.json'),
};

var sdkPath = {
  'macos': 'https://builds.tessel.io/t2/sdk/t2-sdk-macos-x86_64.tar.bz2',
  'linux': 'https://builds.tessel.io/t2/sdk/t2-sdk-linux-x86_64.tar.bz2',
};

var rustlibUrl = 'https://builds.tessel.io/t2/sdk/t2-rustlib-VERSION.tar.gz';

function sha256digest(str) {
  var sha256 = createHash('sha256');
  return sha256.update(str).digest('hex');
}

function sha256stream() {
  var sha256 = createHash('sha256');
  var stream = new Transform();
  stream._transform = function (chunk, encoding, callback) {
    this.push(chunk);
    sha256.update(chunk);
    callback();
  };
  stream.on('finish', function () {
    stream.emit('sha256', sha256.digest('hex'));
  });
  return stream;
}

function sha256file(hash, name) {
  return hash + '  ' + name + '\n';
}

function download(url) {
  var req = request.get(url);

  // When we receive the response
  req.on('response', (res) => {

    // Parse out the length of the incoming bundle
    var contentLength = parseInt(res.headers['content-length'], 10);

    // Create a new progress bar
    var bar = new Progress('     [:bar] :percent :etas remaining', {
      clear: true,
      complete: '=',
      incomplete: ' ',
      width: 20,
      total: contentLength
    });

    // When we get incoming data, update the progress bar
    res.on('data', (chunk) => {
      bar.tick(chunk.length);
    });
  });

  return req;
}

function downloadString(url) {
  return new Promise((resolve, reject) => {
    request(url, (error, response, body) => {
      if (!error && response.statusCode == 200) {
        resolve(body);
      } else {
        reject(error || response.statusCode);
      }
    })
  });
}

var tmpdir = exports.tmpdir = () => {
  return new Promise((resolve, reject) => {
    tmp.dir(function (err, tmppath, cleanup) {
      if (err) {
        reject(err);
      } else {
        resolve({
          path: tmppath,
          cleanup: cleanup,
        });
      }
    });
  });
}

var toolchainPath = exports.toolchainPath = () => {
  return fs.readdirAsync(path.join(paths.sdk, getPlatform()))
    .then((values) => new Promise((resolve, reject) => {
      for (var i = 0; i < values.length; i++) {
        if (values[i].match(/^toolchain\-/)) {
          return resolve(path.join(paths.sdk, getPlatform(), values[i]));
        }
      }
      return reject(new Error("No toolchain found."));
    }));
}

// Checks is CHECKSUM file in our SDK equals our expected checksum.
// This will resolve with checking that the SDK exists and matches the checksum.
var checkSdk = exports.checkSdk = (checksumVerify) => {
  var dir = path.join(paths.sdk, getPlatform());
  return fs.readFileAsync(path.join(dir, "CHECKSUM"))
  .then(checksum => ({
    exists: true,
    checked: checksumVerify == checksum,
    path: dir,
  }), _ => ({
    exists: false,
    checked: false,
    path: dir,
  }))
}

var checkRustlib = exports.checkRustlib = (rustv, checksumVerify) => {
  var dir = path.join(paths.rustlib, rustv)
  return fs.readFileAsync(path.join(dir, "CHECKSUM"))
  .then(checksum => ({
    exists: true,
    checked: checksumVerify == checksum,
    path: dir,
  }), _ => ({
    exists: false,
    checked: false,
    path: dir,
  }))
}

var checkRustTarget = exports.checkRustTarget = (checksumVerify) => {
  var file = paths.rustTarget;
  return new Promise((resolve, reject) => {
    fs.createReadStream(file)
    .on('error', _ => {
      resolve({
        exists: false,
        checked: false,
        path: file,
      })
    })
    .pipe(sha256stream())
    .on('sha256', checksum => {
      checksum = sha256file(checksum, path.basename(file));
      resolve({
        exists: true,
        checked: checksumVerify == checksum,
        path: file,
      })
    })
  });
}

var installSdk = exports.installSdk = () => {
  var url = sdkPath[getPlatform()];
  var checksumVerify = null;

  return downloadString(url + '.sha256')
  .then((checksum) => {
    checksumVerify = checksum;
    return checkSdk(checksumVerify);
  })
  .then((check) => {
    if (check.exists && check.checked) {
      console.error('Latest SDK already installed.');
      return;
    } else if (!check.exists) {
      console.error('Installing SDK...')
    } else {
      console.error('Updating SDK...')
    }

    return fs.mkdirpAsync(path.join(osenv.home(), '.tessel/sdk'))
      .then(() => extractSdk(checksumVerify, path.basename(url), download(url)));
  });
}

var installRustlib = exports.installRustlib = (next) => {
  var url = null;
  var checksumVerify = null;
  var rustv = null;
  var pkgname = null;

  return rustVersion()
  .then(_rustv => {
    rustv = _rustv;
    pkgname = 'MIPS libstd v' + rustv
    url = rustlibUrl.replace('VERSION', rustv);

    return downloadString(url + '.sha256')
  })
  .catch(err => {
    throw new Error(`Could not find a MIPS libstd matching your current Rust version (${rustv}). Only stable Rust versions >= 1.11.0 are supported.`);
  })
  .then(checksum => {
    checksumVerify = checksum;
    return checkRustlib(rustv, checksumVerify);
  })
  .then(check => {
    if (check.exists && check.checked) {
      console.error(`Latest ${pkgname} already installed.`);
      return;
    } else if (!check.exists) {
      console.error(`Installing ${pkgname}...`)
    } else {
      console.error(`Updating ${pkgname}...`)
    }

    return fs.mkdirpAsync(path.join(osenv.home(), '.tessel/rust/rustlib'))
      .then(() => extractRustlib(checksumVerify, path.basename(url), download(url), rustv))
  });
}

var installRustTarget = exports.installRustTarget = next => {
  var url = 'http://builds.tessel.io/t2/sdk/tessel2.json';
  var checksumVerify = null;

  return downloadString(url + '.sha256')
  .then((checksum) => {
    checksumVerify = checksum;
    return checkRustTarget(checksumVerify);
  })
  .then((check) => {
    if (check.exists && check.checked) {
      console.error('Latest target.json already installed.');
      return;
    } else if (!check.exists) {
      console.error('Installing target.json...')
    } else {
      console.error('Updating target.json...')
    }

    return fs.mkdirpAsync(path.join(osenv.home(), '.tessel/rust'))
      .then(() => downloadString(url))
      .then(target => {
        var checksum = sha256file(sha256digest(target), path.basename(url));

        // Check sum.
        if (checksum != checksumVerify) {
          throw new Error('Checksum for downloaded target.json does not match!');
        }

        fs.writeFileSync(path.join(osenv.home(), '.tessel/rust/tessel2.json'), target);
      });
  });
}

function extract(checksumVerify, filename, sdkStream, root, strip, name, decompress) {
  console.log(`Downloading ${name}...`);

  return tmpdir()
  .then(destdir => {
    // Exract tarball to destination.
    var extract = tar.extract(destdir.path, {
      strip: strip,
      ignore: function(name) {
        // Ignore self-directory.
        return path.normalize(name + '/') == path.normalize(destdir.path + '/');
      }
    });

    function tryCleanup() {
      try {
        destdir.cleanup();
      } catch (e) { }
    }

    return new Promise((resolve, reject) => {
      var checksum = '';
      sdkStream
        .pipe(sha256stream())
        .on('sha256', function (sha256) {
          checksum = sha256file(sha256, filename);
        })
        .pipe(decompress)
        // tar-stream has a recursion issue when input chunks are too big.
        // by splitting up the chunks, we never get too deeply nested in the
        // stack.
        .pipe(blocks({ size: 64*1024, zeroPadding: false }))
        .pipe(extract)
        .on('finish', () => {
          // Check sum.
          if (checksum != checksumVerify) {
            return reject(new Error(`Checksum for downloaded ${name} does not match!`));
          }

          // Write out CHECKSUM file.
          fs.writeFileSync(path.join(destdir.path, 'CHECKSUM'), checksum);

          // Remove the old SDK directory.
          fs.removeAsync(root)
          .then(() => {
            // Move temporary directory to target destination.
            return fs.moveAsync(destdir.path, root);
          })
          .finally(() => {
            tryCleanup();
          })
          .then(resolve)
          .catch(reject);
        })
        .on('error', (err) => {
          tryCleanup();
          reject(err);
        })
      });
  });
}

function extractSdk(checksumVerify, filename, sdkStream) {
  var root = path.join(osenv.home(), '.tessel/sdk', 'macos');
  return extract(checksumVerify, filename, sdkStream, root, 2, 'SDK', bz2());
}

function extractRustlib(checksumVerify, filename, sdkStream, rustVersion) {
  var root = path.join(osenv.home(), '.tessel/rust/rustlib', rustVersion);
  return extract(checksumVerify, filename, sdkStream, root, 0, 'MIPS libstd', zlib.createGunzip());
}

var getBuildConfig = exports.getBuildConfig = () => {
  var config = {
    rustv: null,
    toolchainPath: null,
    stagingDir: null,
    rustTargetPath: null,
    rustlibPath: null,
    name: null,
    path: null,
  };

  return rustVersion()
  .then(rustv => {
    config.rustv = rustv;
    return checkSdk()
  })
  .then(check => {
    if (!check.exists) {
      throw new Error('SDK not installed.');
    }
    config.stagingDir = check.path;

    return checkRustlib(config.rustv);
  })
  .then(check => {
    if (!check.exists) {
      throw new Error(`MIPS libstd v${config.rustv} not installed.`);
    }
    config.rustlibPath = check.path;

    return checkRustTarget();
  })
  .then(check => {
    if (!check.exists) {
      throw new Error('target.json not installed.');
    }
    config.rustTargetPath = path.dirname(check.path);

    return toolchainPath();
  })
  .then(toolchainPath => {
    config.toolchainPath = toolchainPath;

    return config;
  });
};

var rustVersion = exports.rustVersion = () => {
  return new Promise((resolve, reject) => {
    var rustc = spawn('rustc', ['-V'])
    var stdout = [];
    rustc.stdout.on('data', (data) => {
      stdout.push(data);
    })
    rustc.stdout.on('close', () => {
      var out = Buffer.concat(stdout).toString();
      var version = out.match(/^rustc\s+(\S+)/)[1];

      if (!version) {
        reject(new Error('Could not identify locally installed rust version.'));
      } else {
        resolve(version);
      }
    });
  });
}

var cargoMetadata = exports.cargoMetadata = () => {
  return new Promise((resolve, reject) => {
    var cargo = spawn('cargo', ['metadata', '--no-deps'], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });

    var buffers = [];
    cargo.stdout.on('data', data => buffers.push(data));
    cargo.on('close', function (code) {
      if (code != 0) {
        process.exit(code);
      } else {
        var metadata = JSON.parse(Buffer.concat(buffers).toString());
        resolve(metadata);
      }
    });
  });
};

var buildTessel = exports.buildTessel = (config) => {
  var env = Object.assign({}, process.env);
  Object.assign(env, {
    STAGING_DIR: config.stagingDir,
    RUST_TARGET_PATH: config.rustTargetPath,
    PATH: path.join(config.toolchainPath, "bin") + ":" + env.PATH,
    RUSTFLAGS: "-L " + config.rustlibPath,
  });

  return new Promise((resolve, reject) => {
    var cargo = spawn('cargo', ['build', '--target=tessel2', '--bin', config.name, '--release'], {
      env: env,
      stdio: ['ignore', 'inherit', 'inherit'],
    });

    cargo.on('error', (error) => {
      console.error(`ERROR ${error.stack}`);
    });

    cargo.on('close', (code) => {
      if (code != 0) {
        process.exit(code);
      }

      resolve();
    });
  });
};

var bundleTessel = exports.bundleTessel = (config) => {
  return new Promise((resolve, reject) => {
    var tarball = path.join(path.dirname(config.path), 'tessel-bundle.tar');
    tar.pack(path.dirname(config.path), {
      entries: [path.basename(config.path)]
    })
    // .pipe(zlib.createGzip())
    .pipe(fs.createWriteStream(tarball))
    .on('finish', function () {
      resolve(tarball);
    })
  });
};