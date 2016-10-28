'use strict';
var http = require('http');
var path = require('path');
var fs = require('fs');

var exec = require('child_process').execSync;
var connect = require('connect');
var bodyParser = require('body-parser');
var chalk = require('chalk');
var winston = require('winston');
var Docker = require('dockerode');
var Q = require('q');

// Start application
var config = require('./config'); // Read package configuration
var logger = setupLogger();       // Initialize logger
var docker = setupDocker();       // Initialize docker
setupServer();                    // Initialize server

/**
 * Setup and configure our logger
 * 
 * @returns an instance of winston logger engine
 */
function setupLogger() {
    return new (winston.Logger)({
        level: 'debug',
        transports: [
            new (winston.transports.Console)({ colorize: true }),
            new (require('winston-daily-rotate-file'))({ filename: 'fint_webhook.log', colorize: true })
        ]
    });
}

/**
 * Setup a tiny server responding to webhook posts
 */
function setupServer() {
    var app = connect();
    logger.info(chalk.green('Booting FINT webhook server'));

    // Parse JSON requests into `req.body`.
    app.use(bodyParser.json());

    // Receive and act on incoming requests.
    app.use(function (req, res) {
        var request = JSON.stringify(req.body, null, 2);
        if (req.method === 'POST' && req.body.package) {
            // Only react to POST and only if request contains 'package'
            logger.info(chalk.cyan('incoming webhook'), req.method, req.url, request);

            // Deploy and terminate
            dockerDeploy(req.body.package, req.body.version)
                .then(function () {
                    res.end('OK\n');
                })
                .catch(function (err) {
                    logger.error(chalk.red(err));
                    res.end('ERROR\n' + err);
                });
        } else {
            // Log out the event
            logger.debug(chalk.red('illegal request received'), req.method, req.url, request);
            res.end('ILLEGAL REQUEST\n');
        }
    });

    // create the http server and listen on port 3009
    var server = http.createServer(app);
    server.on('error', err => logger.error(chalk.red('server error'), err));
    server.listen(config.serverPort, () => logger.info(chalk.green('FINT webhook server is listening on port'), config.serverPort));
}

/**
 * Deploy given package to docker
 * 
 * @param {string} pkgName
 * @param {string} version
 */
function dockerDeploy(pkgName, version) {
    var deployCompleted = Q.defer();
    var name = pkgName.substring(pkgName.indexOf('/') + 1);
    Q.all([
        dockerStop(pkgName),
        dockerPull(pkgName, version)
    ])
        .then(function () {
            logger.debug(chalk.cyan('Initializing new image!'));
            docker.run(pkgName, undefined, undefined, { name: name }, undefined, function (err, data, container) {
                if (err) { return deployCompleted.reject(err); }
                logger.info(chalk.cyan('New image for ' + chalk.yellow(pkgName) + ' up and running on ' + container.Id + '!'));
            })
                .on('container', (data) => logger.debug('Container created'))
                .on('stream', (data) => logger.debug('Streaming...'))
                .on('start', (data) => logger.debug('Starting...'))
                .on('data', (data) => logger.debug('Data'));
            deployCompleted.resolve();
        })
        .catch(err => deployCompleted.reject(err));
    return deployCompleted.promise;
}

/**
 * Stop the docker container corresponding to the given package name
 * 
 * @param {string} pkgName
 * @returns a promise which wil resove once the container is down, or reject if the container cannot be stopped.
 */
function dockerStop(pkgName) {
    var containerStopped = Q.defer();
    logger.debug(chalk.cyan('Stopping containers'));
    docker.listContainers(function (err, containers) {
        if (!containers.length) {
            // No containers are up
            logger.debug(chalk.cyan('No running containers found!'));
            containerStopped.resolve();
        }

        var imageFound = false;
        containers.forEach(function (containerInfo) {
            logger.debug('Comparing: ' + containerInfo.Image + ' - ' + pkgName);
            if (containerInfo.Image === pkgName) {
                imageFound = true;
                var container = docker.getContainer(containerInfo.Id);
                container.kill(function (err, data) {
                    if (err) { return containerStopped.reject(err); }
                    // Container is stopped
                    container.remove(function (err, data) {
                        if (err) { return containerStopped.reject(err); }
                        // Container is removed
                        logger.info(chalk.cyan('Container containing image ' + containerInfo.Image + ' removed!'));
                        containerStopped.resolve();
                    });
                });
            }
        });
        if (!imageFound) {
            logger.debug('No container found hosting ' + pkgName);
            containerStopped.resolve();
        }
    });
    return containerStopped.promise;
}

/**
 * Pulls down a docker image from a remote server
 * 
 * @param {string} pkgName
 * @param {string} version
 * @returns
 */
function dockerPull(pkgName, version) {
    var imagePulled = Q.defer();
    // Download the updated package from bintray
    var binTrayAuth = {
        userName: process.env.DOCKER_USERNAME,
        password: process.env.DOCKER_PASSWORD,
        serveraddress: config.dockerRepo
    };
    logger.debug(chalk.cyan('Pulling new image for ' + chalk.yellow(pkgName) + (version ? ':' + chalk.yellow(version) : '')));
    docker.pull(pkgName + (version ? ':' + version : ''), { 'authconfig': binTrayAuth }, function (err, stream) {
        // streaming output from pull...
        if (err) { return imagePulled.reject(err); }
        docker.modem.followProgress(stream, onFinished, onProgress);
        function onFinished(err, output) {
            if (err) { return imagePulled.reject(err); }
            logger.info(chalk.cyan('Image ' + chalk.yellow(pkgName) + (version ? ':' + chalk.yellow(version) : '') + ' pulled!'));
            imagePulled.resolve();
        }
        function onProgress(event) {
            logger.debug(event);
        }
    });
    return imagePulled.promise;
}

/**
 * Find a image id to use when running up a new instance
 * 
 * @param {string} pkgName
 * @returns a hash of the image corresponding with the given package name
 */
function dockerFindImage(pkgName, version) {
    var imageFound = Q.defer();
    docker.getImage(pkgName).inspect(function (err, imageInfo) {
        if (err) { return imagePulled.reject(err); }

        logger.debug('Image found!');
        imageFound.resolve(imageInfo);
    });
    return imageFound.promise;
}


/**
 * Setup docker environment
 */
function setupDocker() {
    // Configure connection
    logger.debug(chalk.cyan('Setting environment from docker-machine:'));
    var output = exec('docker-machine env default'); // Executed command line
    output.toString().replace(/REM[^.]*/g, '').replace(/SET /g, '').split('\n').forEach(function (setting) {
        // Parsing output from command
        if (setting) {
            var newSet = setting.split('=');
            var key = newSet[0];
            var value = newSet[1];
            if (value.indexOf('tcp://') > -1 && value.indexOf(':') > -1) {
                // Special handling for DOCKER_HOST as this environment variable is too verbose. 
                value = value.replace(/tcp:\/\//g, ''); // Removing tcp protocol if present

                // Splitting out port info into separate environment variable
                var port = value.substring(value.indexOf(':') + 1);
                value = value.substring(0, value.indexOf(':'));
                logger.debug('  - ' + chalk.grey('DOCKER_PORT') + ' = ' + chalk.yellow(port));
                process.env.DOCKER_PORT = port;
            }
            logger.debug('  - ' + chalk.grey(key) + ' = ' + chalk.yellow(value));
            process.env[key] = value;
        }
    });

    // Connect
    docker = new Docker({
        host: process.env.DOCKER_HOST,
        port: process.env.DOCKER_PORT,
        ca: fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH, '/ca.pem')),
        cert: fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH, '/cert.pem')),
        key: fs.readFileSync(path.join(process.env.DOCKER_CERT_PATH, '/key.pem'))
    });

    // Test connection
    docker.listImages(function (err, containers) {
        if (err) throw err;
        else {
            logger.debug(chalk.cyan('Listing images currently present on host:'));
            containers.forEach(function (imageInfo, idx) {
                logger.debug('  - ' + chalk.grey('Image #' + idx) + ' - ' + chalk.yellow(imageInfo.RepoTags));
            });
        }
    });
    return docker;
}
