var utility = require('./utility');
var async = require('async');
var db = require('./db');
var logger = utility.logger;
var fs = require('fs');
var getData = utility.getData;
var request = require('request');
var operations = require('./operations');
var insertPlayer = operations.insertPlayer;
var insertMatch = operations.insertMatch;
var spawn = require('child_process').spawn;
var domain = require('domain');
var JSONStream = require('JSONStream');
var constants = require('./constants.json');
var progress = require('request-progress');

function processParse(job, cb) {
    console.time("parse");
    var attempts = job.toJSON().attempts.remaining;
    var noRetry = attempts <= 1;
    runParser(job, function(err, parsed_data) {
        var match_id = job.data.payload.match_id || parsed_data.match_id;
        job.data.payload.match_id = match_id;
        job.data.payload.parsed_data = parsed_data;
        if (err && noRetry) {
            logger.info("match_id %s, error %s, not retrying", match_id, err);
            job.data.payload.parse_status = 1;
        }
        else if (err) {
            logger.info("match_id %s, error %s, attempts %s", match_id, err, attempts);
            return cb(err);
        }
        else {
            console.timeEnd("parse");
            job.data.payload.parse_status = 2;
        }
        job.update();
        db.matches.update({
            match_id: match_id
        }, {
            $set: job.data.payload,
        }, function(err) {
            return cb(err, job.data.payload);
        });
    });
}

function runParser(job, cb) {
    logger.info("[PARSER] parsing from %s", job.data.payload.url || job.data.payload.fileName);
    if (job.data.payload.expired) {
        return cb("match expired");
    }
    //streams
    var inStream;
    var bz;
    if (job.data.payload.fileName) {
        inStream = fs.createReadStream(job.data.payload.fileName);
    }
    else {
        inStream = progress(request.get({
            url: job.data.payload.url,
            encoding: null,
            timeout: 30000
        })).on('progress', function(state) {
            job.progress(state.percent, 100);
        }).on('response', function(response) {
            error = (response.statusCode !== 200) ? "download error" : error;
        });
        bz = spawn("bunzip2");
    }
    var parser = spawn("java", ["-jar",
        "parser/target/stats-0.1.0.jar"
    ], {
        stdio: ['pipe', 'pipe', 'ignore'], //ignore stderr
        encoding: 'utf8'
    });
    var outStream = JSONStream.parse();
    var exited;
    var error = "incomplete";
    var d = domain.create();
    d.on('error', function exit(err) {
        if (!exited) {
            exited = true;
            cb(err.message || err);
        }
    });
    d.run(function() {
        if (bz) {
            inStream.pipe(bz.stdin);
            bz.stdout.pipe(parser.stdin);
        }
        else {
            inStream.pipe(parser.stdin);
        }
        parser.stdout.pipe(outStream);
        outStream.on('root', preProcess);
        outStream.on('end', postProcess);
    });
    //parse state
    var entries = [];
    var name_to_slot = {};
    var hero_to_slot = {};
    var game_zero = 0;
    var parsed_data = utility.getParseSchema();
    parsed_data.version = constants.parser_version;
    var preTypes = {
        "state": function(e) {
            if (e.key === "PLAYING") {
                game_zero = e.time;
            }
            console.log(e);
        },
        "hero_log": function(e) {
            //get hero by id
            var h = constants.heroes[e.key];
            hero_to_slot[h ? h.name : e.key] = e.slot;
            //push it to entries for hero log
            entries.push(e);
        },
        "name": function(e) {
            name_to_slot[e.key] = e.slot;
        },
        "times": function(e) {
            parsed_data.times.push(e.value);
        },
        "match_id": function(e) {
            parsed_data.match_id = e.value;
        }
    };

    function preProcess(e) {
        if (preTypes[e.type]) {
            preTypes[e.type](e);
        }
        else {
            entries.push(e);
        }
    }
    var types = {
        "epilogue": function() {
            error = false;
        },
        "hero_log": populate,
        "gold_reasons": function(e) {
            if (!constants.gold_reasons[e.key]) {
                //new gold reason
                console.log(e);
            }
            getSlot(e);
        },
        "xp_reasons": function(e) {
            if (!constants.xp_reasons[e.key]) {
                //new xp reason
                console.log(e);
            }
            getSlot(e);
        },
        "purchase": function(e) {
            getSlot(e);
            if (e.key.indexOf("recipe_") === -1) {
                e.type = "purchase_log";
                populate(e);
                //e.type = "purchase_time";
                //e.value = e.time;
                //populate(e);
            }
        },
        "modifier_applied": getSlot,
        "modifier_lost": getSlot,
        "healing": getSlot,
        "ability_trigger": getSlot,
        "item_uses": getSlot,
        "ability_uses": getSlot,
        "kills": function(e) {
            getSlot(e);
            var logs = ["npc_dota_hero_", "_tower", "_rax", "_fort", "_roshan"];
            var pass = logs.some(function(s) {
                return (e.key.indexOf(s) !== -1 && !e.target_illusion);
            });
            if (pass) {
                e.type = "kills_log";
                populate(e);
            }
            //reverse and log killed by
            var r = {
                time: e.time,
                key: e.unit,
                unit: e.key,
                type: "killed_by"
            };
            getSlotReverse(r);
        },
        "damage": function(e) {
            getSlot(e);
            //check if hero hit
            if (e.target_hero && !e.target_illusion) {
                var h = {
                    time: e.time,
                    key: e.inflictor,
                    unit: e.unit,
                    type: "hero_hits"
                };
                getSlot(h);
            }
            //reverse and count as damage taken
            var r = {
                time: e.time,
                key: e.unit,
                unit: e.key,
                value: e.value,
                type: "damage_taken"
            };
            getSlotReverse(r);
        },
        "buyback_log": getSlot,
        "chat": function getChatSlot(e) {
            e.slot = name_to_slot[e.unit];
            //time, key, only, so we lose the original prefix (stored in unit)
            populate(e);
        },
        "stuns": populate,
        "runes": populate,
        "runes_bottled": populate,
        "lh": interval,
        "gold": interval,
        "xp": interval,
        "pos": function(e) {
            e.key = JSON.parse(e.key); //position keys are JSON arrays
            posPopulate(e);
            if (e.time < 600) {
                e.type = "lane_pos";
                posPopulate(e);
            }
            /*
            e.type = "pos_log";
            populate(e);
            */
        },
        "obs": function(e) {
            e.key = JSON.parse(e.key);
            posPopulate(e);
            e.type = "obs_log";
            populate(e);
        },
        "sen": function(e) {
            e.key = JSON.parse(e.key);
            posPopulate(e);
            e.type = "sen_log";
            populate(e);
        }
    };

    function postProcess() {
        for (var i = 0; i < entries.length; i++) {
            var e = entries[i];
            //adjust time by zero value to get actual game time
            e.time -= game_zero;
            if (types[e.type]) {
                types[e.type](e);
            }
            else {
                //no event handler for this type
                console.log(e);
            }
        }
        //fs.writeFileSync("./output.json", JSON.stringify(parsed_data));
        cb(error, parsed_data);
    }

    function interval(e) {
        e.interval = true;
        populate(e);
    }

    function assocName(name) {
        //given a name (npc_dota_visage_familiar...), tries to convert to the associated hero's name
        if (!name) {
            return;
        }
        else if (name in hero_to_slot) {
            return name;
        }
        else if (name.indexOf("illusion_") === 0) {
            //associate illusions with the heroes they are illusions of
            var s = name.slice("illusion_".length);
            return s;
        }
        else if (name.indexOf("npc_dota_") === 0) {
            //try to get the hero this minion is associated with
            //split by _
            var split = name.split("_");
            //get the third element
            var identifiers = [split[2], split[2] + "_" + split[3]];
            for (var i = 0; i < identifiers.length; i++) {
                var id = identifiers[i];
                //append to npc_dota_hero_, see if matches
                var attempt = "npc_dota_hero_" + id;
                if (attempt in hero_to_slot) {
                    return attempt;
                }
            }
        }
    }

    function getSlot(e) {
        //on a reversed field, key should be merged since the unit was damaged/killed by the key or a minion
        //otherwise, unit should be merged since the damage/kill was done by the unit or a minion
        var debug = e.key && e.key.indexOf("visage") > 0;
        if (debug) console.log("before %s", e);
        e.reverse ? e.key = assocName(e.key) : e.unit = assocName(e.unit);
        if (debug) console.log("after %s", e);
        //use slot, then map value (could be undefined)
        e.slot = ("slot" in e) ? e.slot : hero_to_slot[e.unit];
        populate(e);
    }

    function getSlotReverse(e) {
        e.reverse = true;
        getSlot(e);
    }

    function posPopulate(e) {
        var x = e.key[0];
        var y = e.key[1];
        //hash this location
        var h = parsed_data.players[e.slot][e.type];
        if (!h[x]) {
            h[x] = {};
        }
        if (!h[x][y]) {
            h[x][y] = 0;
        }
        h[x][y] += 1;
    }

    function populate(e) {
        if (typeof e.slot === "undefined") {
            //couldn't associate with a player, probably attributed to a creep/tower/necro unit
            //console.log(e);
            return;
        }
        var t = parsed_data.players[e.slot][e.type];
        if (typeof t === "undefined") {
            //parse data player doesn't have a type for this event
            console.log(e);
        }
        else if (t.constructor === Array) {
            //determine whether we want the value only (interval) or the time and key (log)
            //either way this creates a new value so e can be mutated later
            var arrEntry = (e.interval) ? e.value : {
                time: e.time,
                key: e.key
            };
            t.push(arrEntry);
        }
        else if (typeof t === "object") {
            //add it to hash of counts
            e.value = e.value || 1;
            t[e.key] ? t[e.key] += e.value : t[e.key] = e.value;
        }
        else {
            //we must use the full reference since this is a primitive type
            //use the value most of the time, but key when stuns since value only holds Integers in Java
            parsed_data.players[e.slot][e.type] = e.value || Number(e.key);
        }
    }
}

function processApi(job, cb) {
    var payload = job.data.payload;
    job.log("api: starting");
    getData(job.data.url, function(err, data) {
        if (err) {
            job.log(JSON.stringify(err));
            return cb(null);
        }
        else if (data.response) {
            logger.info("summaries response");
            async.mapSeries(data.response.players, insertPlayer, function(err) {
                cb(err, data.response.players);
            });
        }
        else if (payload.match_id) {
            logger.info("details response");
            var match = data.result;
            //join payload with match
            for (var prop in payload) {
                match[prop] = (prop in match) ? match[prop] : payload[prop];
            }
            insertMatch(match, function(err, job2) {
                if (err || !match.request) {
                    return cb(err, job2);
                }
                job.log("api: complete");
                if (!job2) {
                    //request, but didn't queue for parse, probably expired
                    job.log("api: match expired");
                    job.progress(100, 100);
                    cb(err);
                }
                else {
                    job.log("parse: starting");
                    job.progress(0, 100);
                    //request, parse and log the progress
                    job2.on('progress', function(prog) {
                        job.log(prog + "%");
                        job.progress(prog, 100);
                    });
                    job2.on('complete', function() {
                        job.log("parse: complete");
                        job.progress(100, 100);
                        cb(err, job2);
                    });
                }
            });
        }
        else {
            return cb("unknown response");
        }
    });
}

function processMmr(job, cb) {
    var payload = job.data.payload;
    getData(job.data.url, function(err, data) {
        if (err) {
            logger.info(err);
            //retry with backoff
            return cb(err, err);
        }
        logger.info("mmr response");
        if (data.soloCompetitiveRank || data.competitiveRank) {
            db.ratings.insert({
                match_id: payload.match_id,
                account_id: payload.account_id,
                soloCompetitiveRank: data.soloCompetitiveRank,
                competitiveRank: data.competitiveRank,
                time: new Date()
            }, function(err) {
                cb(err);
            });
        }
        else {
            cb(null);
        }
    });
}
module.exports = {
    processParse: processParse,
    processApi: processApi,
    processMmr: processMmr
};
