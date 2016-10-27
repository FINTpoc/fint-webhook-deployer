'use strict';
var http = require('http');
var connect = require('connect');
var bodyParser = require('body-parser');
var debug = require('debug')('wh');

// Configure server
var app = connect();
var port = 3009;

function format(input) { return JSON.stringify(input, null, 2); };

// Parse JSON requests into `req.body`.
app.use(bodyParser.json());

// Receive and act on incoming requests.
app.use(function (req, res) {
    debug('incoming webhook', req.method, req.url, format(req.body));
    res.end('OK\n');
});

debug('booting FINT webhook server');
// create node.js http server and listen on port 3009
var server = http.createServer(app);
server.on('error', function (err) {
    debug('server error', err);
})
server.listen(port, function () {
    debug('FINT webhook server is listening on port', port);
});