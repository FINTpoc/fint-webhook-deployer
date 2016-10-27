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
            deploy(req.body.package, req.body.version)
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
    server.on('error', function (err) {
        logger.error(chalk.red('server error'), err);
    });
    server.listen(config.serverPort, function () {
        logger.info(chalk.green('FINT webhook server is listening on port'), config.serverPort);
    });
}

/**
 * Deploy given package to docker
 * 
 * @param {any} pkgName
 */
function deploy(pkgName, version) {
    // Stop docker
    var deployCompleted = Q.defer();
    var containerStopped = Q.defer();
    logger.debug(chalk.cyan('Stopping containers'));
    docker.listContainers(function (err, containers) {
        if (!containers.length) {
            // No containers are up
            logger.debug(chalk.cyan('No running containers found!'));
            containerStopped.resolve();
        }

        containers.forEach(function (containerInfo) {
            //TODO: Check if we are stopping the correct container. This stops everything for now
            docker.getContainer(containerInfo.Id).stop(function () {
                // Container is stopped
                logger.info(chalk.cyan('Container ' + containerInfo.Id + ' stopped!'));
                containerStopped.resolve();
            });
        });
    });

    // Download the updated package from bintray
    var binTrayAuth = {
        userName: process.env.DOCKER_USERNAME,
        password: process.env.DOCKER_PASSWORD,
        serveraddress: config.dockerRepo
    };
    var imagePulled = Q.defer();
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

    // Start docker with new image
    Q.all([containerStopped.promise, imagePulled.promise])
        .then(function () {
            logger.debug(chalk.cyan('Initializing new image!'));
            docker.run(pkgName, ['-d'], process.stdout, function (err, data, container) {
                if (err) { return deployCompleted.reject(err); }
                logger.info(chalk.cyan('New image for ' + chalk.yellow(pkgName) + ' up and running on ' + container.Id + '!'));
            });
            deployCompleted.resolve();
        })
        .catch(function (err) {
            deployCompleted.reject(err);
        });
    return deployCompleted.promise;
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
                logger.debug('  - ' + chalk.grey('Container #' + idx) + ' - ' + chalk.yellow(imageInfo.RepoTags));
            });
        }
    });
    return docker;
}
