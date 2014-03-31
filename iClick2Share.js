// iClick2Share Node.js server

/* jshint node:true, devel:true, forin:true, noarg:true, eqeqeq:true, evil:true, bitwise:true, strict:true, undef:true, unused:true, indent:4 */

(function () {
    'use strict';

    // Load required libraries
    var nconf = require('nconf'),
        winston = require('winston'),
        fs = require('fs'),
        express = require("express"),
        http = require('http'),
        https = require('https'),
        sio = require('socket.io');

    // Load configuration
    nconf.env().file('./config.json');

    var VERSION = nconf.get('server:version'),
        DEBUG = nconf.get('server:debug'),
        PORT = nconf.get('server:port'),
        SSL = nconf.get('server:ssl');

    // Generate log file
    winston.add(winston.transports.File, { filename: 'iClick2Share.log' });

    // Enables CORS
    function enableCORS(req, res, next) {
        res.header('Access-Control-Allow-Origin', '*');
        res.header('Access-Control-Allow-Methods', 'GET,PUT,POST,DELETE,OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Content-Length, X-Requested-With');

        // intercept OPTIONS method
        if ('OPTIONS' === req.method)
            res.send(200);
        else
            next();
    }

    var app = express();
    // enable CORS!
    app.use(enableCORS);
    // In release: redirect console to https
    if (!DEBUG && SSL)
        app.get('*', function (req, res, next) {
            if (!req.connection.encrypted && req.url.substring(0, 9).toLowerCase() === '/console/')
                res.redirect('https://' + req.headers.host.replace(new RegExp(':' + PORT + '$'), ':' + SSL) + req.url);
            else
                next();
        });
    // Serve static files
    app.use(express.static(__dirname + '/browser'));

    // Create secure and un-secure servers
    var server = http.createServer(app),
        sslServer = https.createServer({
            key: fs.readFileSync('./iClick2Share.key'),
            cert: fs.readFileSync('./iClick2Share.com.crt'),
            ca: [fs.readFileSync('./gd_bundle.crt')]
        }, app);

    // Listen on ports
    if (PORT)
        server.listen(PORT);
    if (SSL)
        sslServer.listen(SSL);

    function createSocket(server) {
        // Connect socket.io, and start listening on ports
        return sio
            .listen(server)         // Listen for clients
            .set('log level', 1)    // Log less
            .set('transports', [
                'websocket',
                'xhr-polling'
            ]);
    }

    // Helper - check if socket is inside room
    function inside(socket, room) {
        return !!socket.manager.roomClients[socket.id][room];
    }

    // Overcome socket.io disconnect namespace bug
    function disconnect(socket) {
        winston.info('Disconnect', socket.id);
        socket.disconnect();
        if (!socket.disconnected && socket.namespace.name)
            socket.manager.namespaces[''].clients().some(function (s) {
                if (s.id === socket.id) {
                    s.disconnect();
                    return true;
                }
                return false;
            });
        return socket;
    }

    var KEEP_ALIVE_INTERVAL = nconf.get('keepAliveInterval') || 4;
    var keepAlive = (function () {
        var KEEP_ALIVE_LIMIT = DEBUG ? 3000 : 3;

        var cbs = [];
        setInterval(function () {
            for (var i = 0; i !== cbs.length; ++i)
                cbs[i]();
        }, KEEP_ALIVE_INTERVAL * 1000);

        return function (namespace) {
            cbs.push(function () {
                namespace.clients().forEach(function (socket) {
                    if (!socket.disconnected)
                        socket.get('keep-alive', function (err, counter) {
                            if (counter > KEEP_ALIVE_LIMIT)
                                disconnect(socket).get('info', function (err, info) {
                                    if (info)
                                        winston.info('Timed out', info.id, info.domain);
                                });
                            else
                                socket.set('keep-alive', ++counter);
                        });
                });
            });
        };
    })();

    var me = {
        name: nconf.get('server:name'),
        version: VERSION,
        keepAliveInterval: KEEP_ALIVE_INTERVAL,
        config: nconf.get('client')
    };

    function connect(socket, proceed) {
        winston.info('Connected', socket.id,
            socket.manager.transports[socket.id].name, (ios === socket.manager ? 'HTTPS' : 'HTTP'));
        socket
            .on('keep-alive', function () {
                this
                    .emit('keep-alive')
                    .set('keep-alive', 0);
            })
            .once('hello', function (info) {
                var socket = this,
                    namespace = this.namespace;
                info.id = namespace.name.substring(1) + '-' + info.id;
                winston.info('Hello', info.id, info.domain);
                this.set('info', info, function (err) {
                    if (err)
                        forceDisconnect(socket, 'error');
                    else
                        unique(socket, info, proceed);
                });
            })
            .emit('hello', me);
    }

    function forceDisconnect(socket, msg) {
        socket.emit('bye', msg);
        setTimeout(function () {
            disconnect(socket);
        }, 1000);
    }

    var waitingSupport = DEBUG ?
        function (id) {
            return waiting.get(ios.of('/support'), id) || waiting.get(io.of('/support'), id);
        } :
        function (id) {
            return waiting.get(ios.of('/support'), id);
        };
    var availableSupport = DEBUG ?
        function (domain) {
            return available.get(ios.of('/support'), domain) || available.get(io.of('/support'), domain);
        } :
        function (domain) {
            return available.get(ios.of('/support'), domain);
        };

    function connectUser(socket, info, support) {
        support = support || waitingSupport(info.id) || availableSupport(info.domain);
        if (!support) {
            winston.info('Support unavailable', info.id, info.domain);
            forceDisconnect(socket, 'none');
        }
        else
            support.get('info', function (err, peer) {
                // Attach user and support
                attach(socket, info.id, support.namespace, peer);
                attach(support, peer.id, socket.namespace, info);
                winston.info('Attached', info.id, peer.id);
            });
    }

    var connects = {
        '/admin': function (socket) {
            // TODO
            forceDisconnect(socket, 'TODO');
        },
        '/support': function (socket) {
            connect(socket, function (socket, info) {
                var user = waiting.get(ios.of('/user'), info.id) || waiting.get(io.of('/user'), info.id);
                if (user)
                    user.get('info', function (err, peer) {
                        connectUser(user, peer, socket);
                    });
                else
                    available.add(socket, info.domain);
            });
        },
        '/user': function (socket) {
            connect(socket, connectUser);
        }
    };

    function attach(socket, id, namespace, peer) {
        if (!inside(socket, peer.id))
            socket
                .join(peer.id)
                .once('disconnect', function () {
                    // If we are still attached, wait for peer to come back
                    if (inside(this, peer.id))
                        waiting.add(this);
                })
                .once('bye', function () {
                    winston.info('Bye from', id);
                    disconnect(this.leave(peer.id));
                    namespace.clients(id).forEach(function (other) {
                        forceDisconnect(other.leave(id));
                    });
                })
                .on('message', function (payload) {
                    namespace.in(id).send(payload);
                })
                .emit('attached', peer);
    }

    function unique(socket, info, proceed) {
        var id = info.id,
            already = false;
        socket.namespace.clients(id).forEach(function (other) {
            if (other.id === socket.id) {
                winston.info('Same', id);
                already = true;
            }
            else {
                winston.info('Zombie', id);
                forceDisconnect(other.leave(id), 'zombie');
            }
        });
        if (!already)
            setTimeout(function () {
                proceed(socket.join(id), info);
            }, 0);
    }

    var available = {
        add: function (socket, domain) {
            return socket.join(domain);
        },
        get: function (namespace, domain) {
            var result = namespace.clients(domain)[0];
            return result && result.leave(domain);
        }
    };

    var waiting = (function () {
        var WAIT_DURATION = nconf.get('server:wait');
        return {
            add: function (socket) {
                winston.info('Waiting', socket.namespace.name, socket.id);
                return socket.set('timeout', setTimeout(function () {
                    socket.get('info', function (err, info) {
                        if (info)
                            winston.info('Done waiting', info.id, info.domain);
                    });
                    forceDisconnect(socket, 'timeout');
                }, WAIT_DURATION));
            },
            get: function (namespace, peer) {
                var result = namespace.clients(peer)[0];
                return result && result.get('timeout', function (err, timeout) {
                    winston.info('Stop waiting', result.id);
                    clearTimeout(timeout);
                });
            }
        };
    })();

    var ios, io;
    (function () {
        winston.info('iClick2Share server started', VERSION, DEBUG ? '(debug)' : '(release)');

        var namespace;

        // Any client type can connect via HTTPS
        ios = createSocket(sslServer);
        for (namespace in connects)
            if (connects.hasOwnProperty(namespace))
                keepAlive(ios.of(namespace).on('connection', connects[namespace]));

        // In release mode (not DEBUG) only users can connect http
        io = createSocket(server);
        if (DEBUG || !SSL) {
            for (namespace in connects)
                if (connects.hasOwnProperty(namespace))
                    keepAlive(io.of(namespace).on('connection', connects[namespace]));
        }
        else
            keepAlive(io.of('/user').on('connection', connects['/user']));
    })();
})();
