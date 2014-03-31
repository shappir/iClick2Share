// iClick2Share Node.js server

/* jshint node:true, devel:true, forin:true, noarg:true, eqeqeq:true, evil:true, bitwise:true, strict:true, undef:true, unused:true, indent:4, maxerr:50 */

(function () {
    'use strict';

    // Load required libraries
    var nconf = require('nconf'),
        winston = require('winston'),
        http = require('http'),
        express = require("express"),
        app = require("express")(),
        server = http.createServer(app),
        io = require('socket.io').listen(server);

    // Log less
    io.set('log level', 1);

    // Generate log file
    winston.add(winston.transports.File, { filename: 'iClick2Share.log' });

    // Load configuration
    nconf.env().file('./config.json');

    // Start listening on port
    server.listen(nconf.get('server:port'));

    // Support CORS
    app.all('/', function (req, res, next) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "X-Requested-With");
        next();
    });

    // Serve static files
    app.use(express.static(__dirname + '/browser'));

    // Types of clients
    var types = {
        admin: connectAdmin,
        support: connectSupport,
        user: connectUser
    };

    // Use Socket.IO for communication
    var marker = 0,
        me = {
            name: nconf.get('server:name'),
            version: nconf.get('server:version'),
            config: nconf.get('client')
        };

    winston.info('iClick2Share server started', me.version);

    io.sockets.on('connection', function (socket) {
        // Say hello to new client to initiate communication, and wait for response
        socket
            .emit('hello', me)
            .once('hello', function (info) {
                winston.info('hello', info.type);
                var type = types[info.type];
                if (!type)
                    this.disconnect();    // Unknown client type
                else {
                    info.id = info.id || ++marker;
                    this.set('info', info, type.bind(this, info));
                }
            });
    });

    var domains = (function () {
        var domains = Object.create(null);

        function available() {
            var storage = [];
            return {
                add: function (socket) {
                    storage.push(socket);
                },
                get: function () {
                    return storage.shift();
                },
                remove: function (socket) {
                    var i = storage.indexOf(socket);
                    if (i !== -1)
                        storage.splice(i, 1);
                }
            };
        }

        function waiting () {
            var storage = Object.create(null);
            return {
                add: function (id, socket) {
                    if (!storage[id]) {
                        winston.info('waiting', id);
                        storage[id] = [socket, setTimeout(function () {
                            winston.info('Timed out', id);
                            disconnect(storage[id][0]);
                            delete storage[id];
                        }, nconf.get('server:wait'))];
                    }
                },
                get: function (id) {
                    var item = storage[id];
                    if (!item)
                        return null;
                    delete storage[id];
                    clearTimeout(item[1]);
                    return item[0];
                }
            };
        }

        return function (domain) {
            var data = domains[domain];
            if (!data)
                domains[domain] = data = {
                    available: available(),
                    waiting: waiting(),
                    get: function (id) {
                        return this.waiting.get(id) || this.available.get();
                    }
                };
            return data;
        };
    })();

    function connectAdmin() {
        // TODO
    }

    // Handle connecting support operator
    function connectSupport(info) {
        winston.info('Connect support', info.domain, info.id);

        // If user already waiting for this support session - resume
        var support = this,
            domain = domains(info.domain),
            user = domain.waiting.get(info.id);
        if (user) {
            winston.info('To waiting user');
            user.get('info', function (err, other) {
                connectUser(other, support);
            });
        }
        else {
            // Otherwise, put in available list
            domain.available.add(support);
            winston.info('Available support:', info.id);
            this.on('disconnect', function () {
                domain.available.remove(support);
                winston.info('Unavailable support:', info.id);
            });
        }
    }

    // Handle connecting user
    function connectUser(info, support) {
        var domain = domains(info.domain);
        support = support || domain.get(info.id);
        if (!support) {
            winston.info('Support unavailable ', info.domain, info.id);
            this.emit('bye');
        }
        else {
            // Attach user and support
            var user = this;
            support.get('info', function (err, other) {
                winston.info('Attaching', info.id, other.id);

                // trade info
                info.self = other.id;
                other.self = info.id;

                support.removeAllListeners('disconnect');
                var wait = domain.waiting.add;
                attach(support, user, info, wait);
                attach(user, support, other, wait);

                winston.info('Attached', info.id, other.id);
            });
        }
    }

    function attach(src, dst, info, wait) {
        var release = wait.bind(null, info.self, dst);
        if (src.disconnected)
            release(dst);
        else {
            src
                .emit('attached', info)
                .on('message', function (payload) {
                    dst.send(payload);
                })
                .once('bye', function () {
                    dst
                        .removeAllListeners('disconnect')
                        .emit('bye');
                    disconnect(src);
                })
                .on('disconnect', release);
        }
    }

    function disconnect(socket) {
        winston.info('Disconnected');
        socket
            .removeAllListeners('disconnect')
            .emit('bye');
    }
})();
